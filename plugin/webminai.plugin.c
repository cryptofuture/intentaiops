/* Keep platform security flags visible under strict C17 builds. */
#if defined(__APPLE__) || defined(WEBMINAI_TARGET_MACOS)
#define _DARWIN_C_SOURCE
#endif

/* FreeBSD exposes setgroups() only with its default BSD API visibility. */
#if !defined(__FreeBSD__)
#define _POSIX_C_SOURCE 200809L
#endif

#if defined(__linux__)
#define _DEFAULT_SOURCE
#endif
#if defined(WEBMINAI_TARGET_KUBERNETES)
#define WEBMINAI_PLATFORM_KUBERNETES 1
#define WEBMINAI_PLATFORM_NAME "kubernetes"
#elif defined(WEBMINAI_TARGET_MACOS)
#define WEBMINAI_PLATFORM_MACOS 1
#define WEBMINAI_PLATFORM_NAME "macos"
#elif defined(__linux__) && !defined(WEBMINAI_TARGET_FREEBSD)
#define _GNU_SOURCE
#define WEBMINAI_PLATFORM_LINUX 1
#define WEBMINAI_PLATFORM_NAME "linux"
#elif defined(__FreeBSD__) || defined(WEBMINAI_TARGET_FREEBSD)
#define WEBMINAI_PLATFORM_FREEBSD 1
#define WEBMINAI_PLATFORM_NAME "freebsd"
#elif defined(__APPLE__) || defined(WEBMINAI_TARGET_MACOS)
#define WEBMINAI_PLATFORM_MACOS 1
#define WEBMINAI_PLATFORM_NAME "macos"
#else
#error "webminai.plugin supports only Linux, FreeBSD, macOS, and Kubernetes"
#endif

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#if defined(WEBMINAI_PLATFORM_MACOS)
#include <CommonCrypto/CommonDigest.h>
#define SHA256_DIGEST_LENGTH CC_SHA256_DIGEST_LENGTH
#define SHA256_CBLOCK CC_SHA256_BLOCK_BYTES
#define SHA256_CTX CC_SHA256_CTX
#define SHA256_Init CC_SHA256_Init
#define SHA256_Update CC_SHA256_Update
#define SHA256_Final CC_SHA256_Final
#define OPENSSL_cleanse(pointer, length) memset((pointer), 0, (length))
static int constant_time_compare(const unsigned char *left, const unsigned char *right, size_t length) {
    unsigned char difference = 0;
    for (size_t index = 0; index < length; index++) difference |= left[index] ^ right[index];
    return difference;
}
#define CRYPTO_memcmp(left, right, length) constant_time_compare((left), (right), (length))
#else
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#endif
#include <poll.h>
#if defined(WEBMINAI_PLATFORM_LINUX)
#include <sched.h>
#endif
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef WEBMINAI_PLUGIN_VERSION
#define WEBMINAI_PLUGIN_VERSION "0.0.0-dev"
#endif
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
#define DEFAULT_KEY_FILE "/var/run/secrets/webminai/action.key"
#elif defined(WEBMINAI_PLATFORM_FREEBSD)
#define DEFAULT_KEY_FILE "/var/db/webminai/action.key"
#elif defined(WEBMINAI_PLATFORM_MACOS)
#define DEFAULT_KEY_FILE "/var/db/webminai/action.key"
#else
#define DEFAULT_KEY_FILE "/var/lib/webminai/action.key"
#endif
#define MAX_REQUEST_BYTES (128 * 1024)
#define MAX_COMMAND_BYTES (32 * 1024)
#define MAX_SIGNED_COMMAND_BYTES (48 * 1024)
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
#define MAX_OUTPUT_BYTES (256 * 1024)
#else
#define MAX_OUTPUT_BYTES (4 * 1024)
#endif
#define MAX_REPLAY_NONCES 256
#define MAX_JOB_TIMEOUT_SECONDS (24 * 60 * 60)
#define JOB_RESULT_MAGIC 0x574d4a31U

#if defined(WEBMINAI_PLATFORM_FREEBSD) || defined(WEBMINAI_PLATFORM_MACOS)
#define DEFAULT_JOB_ROOT "/var/db/webminai/jobs"
#else
#define DEFAULT_JOB_ROOT "/var/lib/webminai/jobs"
#endif

struct job_result_header {
    uint32_t magic;
    int32_t exit_code;
    int32_t signal_number;
    uint32_t stdout_length;
    uint32_t stderr_length;
    uint8_t timed_out;
    uint8_t stdout_truncated;
    uint8_t stderr_truncated;
};

struct buffer {
    char *data;
    size_t length;
    size_t capacity;
    bool truncated;
};

struct command_result {
    int exit_code;
    int signal_number;
    bool timed_out;
    struct buffer stdout_buffer;
    struct buffer stderr_buffer;
};

#if defined(WEBMINAI_PLATFORM_KUBERNETES)
struct kubernetes_request {
    char method[7];
    char content_type[48];
    char *path;
    unsigned char *body;
    size_t body_length;
};
#endif

static char replay_nonces[MAX_REPLAY_NONCES][65];
static size_t replay_index;

static void respond_error(const char *transaction, int status, const char *message);
static void respond_health(const char *transaction);
static void handle_payload(const char *header, const char *body);
static ssize_t read_protocol_line(char **line, size_t *line_capacity);
static bool verify_request(const char *body, char **command, char *error, size_t error_size);
static int run_command(const char *command, int timeout_seconds, struct command_result *result);
static int run_command_with_pid(const char *command, int timeout_seconds, struct command_result *result, const char *pid_file);
static void respond_command(const char *transaction, const struct command_result *result);
static void respond_begin(const char *transaction, int status);
static void respond_end(void);
static void json_string(const char *value, size_t length);
static void json_base64(const char *value, size_t length);
#if !defined(WEBMINAI_PLATFORM_KUBERNETES)
static int enter_host_mount_namespace(void);
static void handle_job_start(const char *transaction, const char *request);
static void handle_job_status(const char *transaction, const char *job_id);
static void handle_job_cancel(const char *transaction, const char *job_id);
static void handle_job_cleanup(const char *transaction, const char *job_id);
static bool persist_job_file(const char *path, const struct command_result *result);
static bool persist_job_result(const char *job_id, const struct command_result *result);
static bool load_job_result(const char *job_id, struct command_result *result);
static int run_job_worker(const char *job_id);
#endif
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
static int run_kubernetes_request(const char *command, int timeout_seconds, struct command_result *result);
#endif

static void process_payload_header(char *header, char **line, size_t *line_capacity) {
    struct buffer body = {0};
    while (read_protocol_line(line, line_capacity) >= 0) {
        if (strcmp(*line, "FUNCTION_PAYLOAD_END\n") == 0 ||
            strcmp(*line, "FUNCTION_PAYLOAD_END\r\n") == 0) {
            break;
        }
        size_t length = strlen(*line);
        if (body.length + length > MAX_REQUEST_BYTES) {
            body.truncated = true;
            continue;
        }
        if (body.capacity < body.length + length + 1) {
            size_t capacity = (body.length + length + 1) * 2;
            char *next = realloc(body.data, capacity);
            if (next == NULL) break;
            body.data = next;
            body.capacity = capacity;
        }
        memcpy(body.data + body.length, *line, length);
        body.length += length;
        body.data[body.length] = '\0';
    }
    if (body.data == NULL) body.data = strdup("");
    if (body.truncated) {
        char transaction[65] = {0};
        sscanf(header, "%*s %64s", transaction);
        respond_error(transaction, 413, "request payload is too large");
    } else {
        handle_payload(header, body.data);
    }
    free(body.data);
}

static ssize_t read_protocol_line(char **line, size_t *line_capacity) {
    for (;;) {
        errno = 0;
        ssize_t length = getline(line, line_capacity, stdin);
        if (length >= 0) return length;
        if (feof(stdin)) return -1;
        if (ferror(stdin) && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
            clearerr(stdin);
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                struct pollfd descriptor = {STDIN_FILENO, POLLIN | POLLHUP, 0};
                while (poll(&descriptor, 1, -1) < 0 && errno == EINTR) {}
            }
            continue;
        }
        fprintf(stderr, "webminai.plugin: failed to read Netdata protocol input: %s\n", strerror(errno));
        return -1;
    }
}

static int plugin_loop(void) {
    char *line = NULL;
    size_t line_capacity = 0;

    setvbuf(stdout, NULL, _IOLBF, 0);
    printf("CHART webminai.status '' 'WebminAI Stage 2 status' 'state' webminai webminai.status line 90000 1\n");
    printf("DIMENSION active 'active' absolute 1 1\n");
    printf("BEGIN webminai.status\nSET active = 1\nEND\n");
    printf("FUNCTION GLOBAL \"webminai:health\" 10 \"WebminAI plugin health\" \"\" \"any\" 100 1\n");
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
    printf("FUNCTION GLOBAL \"webminai:command\" 300 \"Run a signed, approved Kubernetes API request\" \"\" \"any\" 100 1\n");
#else
    printf("FUNCTION GLOBAL \"webminai:command\" 300 \"Run a signed, approved command as root\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_start\" 15 \"Start a signed, approved root command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_status\" 15 \"Read a signed WebminAI command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_cancel\" 15 \"Cancel a signed WebminAI command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_cleanup\" 15 \"Remove a completed WebminAI command job\" \"\" \"any\" 100 1\n");
#endif
    fflush(stdout);

    while (read_protocol_line(&line, &line_capacity) >= 0) {
        while (waitpid(-1, NULL, WNOHANG) > 0) {}
        if (strcmp(line, "QUIT\n") == 0 || strcmp(line, "QUIT\r\n") == 0) break;
        if (strncmp(line, "FUNCTION_PAYLOAD ", 17) == 0 ||
            strncmp(line, "FUNCTION_PAYLOAD_BEGIN ", 23) == 0) {
            char *header = strdup(line);
            if (header == NULL) break;
            process_payload_header(header, &line, &line_capacity);
            free(header);
        } else if (strncmp(line, "FUNCTION ", 9) == 0) {
            char transaction[65] = {0};
            if (sscanf(line, "FUNCTION %64s", transaction) != 1) continue;
            if (strstr(line, "webminai:health") != NULL) {
                respond_health(transaction);
            } else if (strstr(line, "webminai:") != NULL) {
                respond_error(transaction, 400, "WebminAI functions require a signed JSON payload");
            }
        }
    }
    free(line);
    return 0;
}

static void handle_payload(const char *header, const char *body) {
    char transaction[65] = {0};
    int timeout_seconds = 30;
    if (sscanf(header, "%*s %64s %d", transaction, &timeout_seconds) < 1) return;
    if (strstr(header, "webminai:health") != NULL) {
        respond_health(transaction);
        return;
    }
    bool command_function = strstr(header, "webminai:command") != NULL;
    bool job_start_function = strstr(header, "webminai:job_start") != NULL;
    bool job_status_function = strstr(header, "webminai:job_status") != NULL;
    bool job_cancel_function = strstr(header, "webminai:job_cancel") != NULL;
    bool job_cleanup_function = strstr(header, "webminai:job_cleanup") != NULL;
    if (!command_function && !job_start_function && !job_status_function &&
        !job_cancel_function && !job_cleanup_function) {
        respond_error(transaction, 404, "unknown function");
        return;
    }

    char *command = NULL;
    char error[256] = {0};
    if (!verify_request(body, &command, error, sizeof(error))) {
        respond_error(transaction, 403, error);
        return;
    }

#if !defined(WEBMINAI_PLATFORM_KUBERNETES)
    if ((job_start_function || job_status_function || job_cancel_function || job_cleanup_function) &&
        geteuid() == 0 && enter_host_mount_namespace() != 0) {
        free(command);
        respond_error(transaction, 500, "could not enter the host mount namespace for job storage");
        return;
    }
    if (job_start_function) {
        handle_job_start(transaction, command);
        free(command);
        return;
    }
    if (job_status_function) {
        handle_job_status(transaction, command);
        free(command);
        return;
    }
    if (job_cancel_function) {
        handle_job_cancel(transaction, command);
        free(command);
        return;
    }
    if (job_cleanup_function) {
        handle_job_cleanup(transaction, command);
        free(command);
        return;
    }
#else
    if (job_start_function || job_status_function || job_cancel_function || job_cleanup_function) {
        free(command);
        respond_error(transaction, 404, "command jobs are unavailable for the Kubernetes API plugin");
        return;
    }
#endif

    if (strlen(command) > MAX_COMMAND_BYTES) {
        free(command);
        respond_error(transaction, 400, "command is too long");
        return;
    }

    if (timeout_seconds < 1) timeout_seconds = 1;
    if (timeout_seconds > 300) timeout_seconds = 300;
    struct command_result result = {0};
    if (run_command(command, timeout_seconds, &result) != 0) {
        free(command);
        respond_error(transaction, 500, "failed to start command");
        return;
    }
    free(command);
    respond_command(transaction, &result);
    free(result.stdout_buffer.data);
    free(result.stderr_buffer.data);
}

static bool extract_wrapper(const char *body, char **payload, char mac[65]) {
    const char *prefix = "{\"payload\":\"";
    const char *middle = "\",\"mac\":\"";
    size_t body_length = strlen(body);
    while (body_length > 0 && (body[body_length - 1] == '\n' || body[body_length - 1] == '\r')) body_length--;
    if (strncmp(body, prefix, strlen(prefix)) != 0 || body_length < strlen(prefix) + strlen(middle) + 67) return false;

    const char *middle_position = strstr(body + strlen(prefix), middle);
    if (middle_position == NULL) return false;
    const char *mac_start = middle_position + strlen(middle);
    if ((size_t)(mac_start - body) + 66 != body_length) return false;
    if (mac_start[64] != '"' || mac_start[65] != '}') return false;

    for (size_t index = 0; index < 64; index++) {
        char value = mac_start[index];
        if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F'))) return false;
        mac[index] = value;
    }
    mac[64] = '\0';

    size_t payload_length = (size_t)(middle_position - (body + strlen(prefix)));
    *payload = malloc(payload_length + 1);
    if (*payload == NULL) return false;
    memcpy(*payload, body + strlen(prefix), payload_length);
    (*payload)[payload_length] = '\0';
    return true;
}

static int decode_base64url(const char *input, unsigned char **output, size_t *output_length) {
    size_t input_length = strlen(input);
    size_t padded_length = ((input_length + 3) / 4) * 4;
    char *padded = malloc(padded_length + 1);
    if (padded == NULL) return -1;
    for (size_t index = 0; index < input_length; index++) {
        char value = input[index];
        if (value == '-') value = '+';
        else if (value == '_') value = '/';
        else if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9'))) {
            free(padded);
            return -1;
        }
        padded[index] = value;
    }
    for (size_t index = input_length; index < padded_length; index++) padded[index] = '=';
    padded[padded_length] = '\0';

    unsigned char *decoded = malloc((padded_length / 4) * 3 + 1);
    if (decoded == NULL) {
        free(padded);
        return -1;
    }
#if defined(WEBMINAI_PLATFORM_MACOS)
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int length = 0;
    for (size_t index = 0; index < padded_length; index += 4) {
        unsigned int value = 0;
        for (size_t offset = 0; offset < 4; offset++) {
            char current = padded[index + offset];
            const char *found = strchr(alphabet, current);
            value = (value << 6) | (current == '=' ? 0 : (unsigned int)(found - alphabet));
        }
        decoded[length++] = (unsigned char)(value >> 16);
        if (padded[index + 2] != '=') decoded[length++] = (unsigned char)(value >> 8);
        if (padded[index + 3] != '=') decoded[length++] = (unsigned char)value;
    }
#else
    int length = EVP_DecodeBlock(decoded, (const unsigned char *)padded, (int)padded_length);
#endif
    free(padded);
    if (length < 0) {
        free(decoded);
        return -1;
    }
#if !defined(WEBMINAI_PLATFORM_MACOS)
    if (padded_length > input_length) length -= (int)(padded_length - input_length);
#endif
    decoded[length] = '\0';
    *output = decoded;
    *output_length = (size_t)length;
    return 0;
}

static int hex_value(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

#if defined(WEBMINAI_PLATFORM_KUBERNETES)
static bool valid_kubernetes_method(const char *method) {
    return strcmp(method, "GET") == 0 || strcmp(method, "POST") == 0 ||
        strcmp(method, "PUT") == 0 || strcmp(method, "PATCH") == 0 ||
        strcmp(method, "DELETE") == 0;
}

static bool valid_kubernetes_content_type(const char *content_type) {
    return strcmp(content_type, "application/json") == 0 ||
        strcmp(content_type, "application/merge-patch+json") == 0 ||
        strcmp(content_type, "application/apply-patch+yaml") == 0;
}

static bool valid_kubernetes_path(const char *path) {
    if (strncmp(path, "/api/", 5) != 0 && strncmp(path, "/apis/", 6) != 0 && strcmp(path, "/version") != 0) {
        return false;
    }
    if (strstr(path, "..") != NULL || strlen(path) > 4096) return false;
    for (const unsigned char *cursor = (const unsigned char *)path; *cursor != '\0'; cursor++) {
        unsigned char value = *cursor;
        if ((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
            (value >= '0' && value <= '9') || strchr("/_-.?&=%:,*|~", value) != NULL) continue;
        return false;
    }
    return true;
}

static void free_kubernetes_request(struct kubernetes_request *request) {
    free(request->path);
    free(request->body);
    memset(request, 0, sizeof(*request));
}

static void close_pipe(int descriptors[2]) {
    for (size_t index = 0; index < 2; index++) {
        if (descriptors[index] >= 0) {
            close(descriptors[index]);
            descriptors[index] = -1;
        }
    }
}

static bool parse_kubernetes_request(const char *command, struct kubernetes_request *request) {
    char *copy = strdup(command);
    if (copy == NULL) return false;
    char *version = NULL;
    char *method = NULL;
    char *encoded_path = NULL;
    char *content_type = NULL;
    char *encoded_body = NULL;
    char *save_pointer = NULL;
    char *line = strtok_r(copy, "\n", &save_pointer);
    while (line != NULL) {
        char *separator = strchr(line, '=');
        if (separator == NULL || separator == line) goto invalid;
        *separator = '\0';
        char *value = separator + 1;
        if (strcmp(line, "v") == 0 && version == NULL) version = value;
        else if (strcmp(line, "method") == 0 && method == NULL) method = value;
        else if (strcmp(line, "path") == 0 && encoded_path == NULL) encoded_path = value;
        else if (strcmp(line, "contentType") == 0 && content_type == NULL) content_type = value;
        else if (strcmp(line, "body") == 0 && encoded_body == NULL) encoded_body = value;
        else goto invalid;
        line = strtok_r(NULL, "\n", &save_pointer);
    }
    if (version == NULL || strcmp(version, "1") != 0 || method == NULL || encoded_path == NULL ||
        content_type == NULL || encoded_body == NULL || !valid_kubernetes_method(method) ||
        !valid_kubernetes_content_type(content_type)) goto invalid;

    unsigned char *path = NULL;
    size_t path_length = 0;
    if (decode_base64url(encoded_path, &path, &path_length) != 0 || path_length == 0 ||
        memchr(path, '\0', path_length) != NULL) {
        free(path);
        goto invalid;
    }
    if (!valid_kubernetes_path((const char *)path)) {
        free(path);
        goto invalid;
    }

    unsigned char *body = NULL;
    size_t body_length = 0;
    if (decode_base64url(encoded_body, &body, &body_length) != 0 || body_length > MAX_COMMAND_BYTES) {
        free(path);
        free(body);
        goto invalid;
    }
    if ((strcmp(method, "POST") == 0 || strcmp(method, "PUT") == 0 || strcmp(method, "PATCH") == 0) &&
        body_length == 0) {
        free(path);
        free(body);
        goto invalid;
    }

    snprintf(request->method, sizeof(request->method), "%s", method);
    snprintf(request->content_type, sizeof(request->content_type), "%s", content_type);
    request->path = (char *)path;
    request->body = body;
    request->body_length = body_length;
    free(copy);
    return true;

invalid:
    free(copy);
    return false;
}
#endif

static bool decode_hex(const char *input, unsigned char *output, size_t output_length) {
    if (strlen(input) != output_length * 2) return false;
    for (size_t index = 0; index < output_length; index++) {
        int high = hex_value(input[index * 2]);
        int low = hex_value(input[index * 2 + 1]);
        if (high < 0 || low < 0) return false;
        output[index] = (unsigned char)((high << 4) | low);
    }
    return true;
}

static bool hmac_sha256(const unsigned char key[32], const unsigned char *data, size_t data_length,
                        unsigned char output[SHA256_DIGEST_LENGTH]) {
    unsigned char inner_pad[SHA256_CBLOCK];
    unsigned char outer_pad[SHA256_CBLOCK];
    unsigned char inner_digest[SHA256_DIGEST_LENGTH];
    SHA256_CTX context;
    memset(inner_pad, 0x36, sizeof(inner_pad));
    memset(outer_pad, 0x5c, sizeof(outer_pad));
    for (size_t index = 0; index < 32; index++) {
        inner_pad[index] ^= key[index];
        outer_pad[index] ^= key[index];
    }
    bool success = SHA256_Init(&context) == 1 &&
        SHA256_Update(&context, inner_pad, sizeof(inner_pad)) == 1 &&
        SHA256_Update(&context, data, data_length) == 1 &&
        SHA256_Final(inner_digest, &context) == 1 &&
        SHA256_Init(&context) == 1 &&
        SHA256_Update(&context, outer_pad, sizeof(outer_pad)) == 1 &&
        SHA256_Update(&context, inner_digest, sizeof(inner_digest)) == 1 &&
        SHA256_Final(output, &context) == 1;
    OPENSSL_cleanse(&context, sizeof(context));
    OPENSSL_cleanse(inner_pad, sizeof(inner_pad));
    OPENSSL_cleanse(outer_pad, sizeof(outer_pad));
    OPENSSL_cleanse(inner_digest, sizeof(inner_digest));
    return success;
}

static bool read_key(unsigned char key[32]) {
    const char *path = NULL;
    if (getuid() == geteuid()) path = getenv("WEBMINAI_KEY_FILE");
    if (path == NULL || *path == '\0') path = DEFAULT_KEY_FILE;
    FILE *file = fopen(path, "r");
    if (file == NULL) return false;
    char hex[66] = {0};
    bool success = fgets(hex, sizeof(hex), file) != NULL;
    fclose(file);
    hex[strcspn(hex, "\r\n")] = '\0';
    return success && decode_hex(hex, key, 32);
}

struct signed_payload_fields {
    char *version;
    char *issued_at;
    char *request_id;
    char *nonce;
    char *command;
};

static bool parse_signed_payload(char *payload, struct signed_payload_fields *fields) {
    char *save_pointer = NULL;
    char *line = strtok_r(payload, "\n", &save_pointer);
    while (line != NULL) {
        char *separator = strchr(line, '=');
        if (separator == NULL || separator == line || separator[1] == '\0') return false;
        *separator = '\0';
        char *value = separator + 1;

        if (strcmp(line, "v") == 0 && fields->version == NULL) fields->version = value;
        else if (strcmp(line, "issuedAt") == 0 && fields->issued_at == NULL) fields->issued_at = value;
        else if (strcmp(line, "requestId") == 0 && fields->request_id == NULL) fields->request_id = value;
        else if (strcmp(line, "nonce") == 0 && fields->nonce == NULL) fields->nonce = value;
        else if (strcmp(line, "command") == 0 && fields->command == NULL) fields->command = value;
        else return false;

        line = strtok_r(NULL, "\n", &save_pointer);
    }
    return fields->version != NULL && fields->issued_at != NULL && fields->request_id != NULL &&
        fields->nonce != NULL && fields->command != NULL;
}

static bool nonce_seen(const char *nonce) {
    for (size_t index = 0; index < MAX_REPLAY_NONCES; index++) {
        if (strcmp(replay_nonces[index], nonce) == 0) return true;
    }
    snprintf(replay_nonces[replay_index], sizeof(replay_nonces[replay_index]), "%s", nonce);
    replay_index = (replay_index + 1) % MAX_REPLAY_NONCES;
    return false;
}

static bool verify_request(const char *body, char **command, char *error, size_t error_size) {
    char *encoded_payload = NULL;
    char mac_hex[65] = {0};
    if (!extract_wrapper(body, &encoded_payload, mac_hex)) {
        snprintf(error, error_size, "invalid request envelope");
        return false;
    }

    unsigned char *payload_bytes = NULL;
    size_t payload_length = 0;
    if (decode_base64url(encoded_payload, &payload_bytes, &payload_length) != 0) {
        free(encoded_payload);
        snprintf(error, error_size, "invalid payload encoding");
        return false;
    }
    free(encoded_payload);

    unsigned char key[32] = {0};
    unsigned char expected[SHA256_DIGEST_LENGTH] = {0};
    unsigned char supplied[32] = {0};
    if (!read_key(key) || !decode_hex(mac_hex, supplied, sizeof(supplied))) {
        OPENSSL_cleanse(key, sizeof(key));
        free(payload_bytes);
        snprintf(error, error_size, "command authentication is unavailable");
        return false;
    }
    bool authenticated = hmac_sha256(key, payload_bytes, payload_length, expected);
    OPENSSL_cleanse(key, sizeof(key));
    if (!authenticated || CRYPTO_memcmp(expected, supplied, sizeof(supplied)) != 0) {
        free(payload_bytes);
        snprintf(error, error_size, "invalid command signature");
        return false;
    }

    struct signed_payload_fields fields = {0};
    if (!parse_signed_payload((char *)payload_bytes, &fields) || strcmp(fields.version, "1") != 0 ||
        strlen(fields.nonce) > 64 || strlen(fields.request_id) > 64) {
        free(payload_bytes);
        snprintf(error, error_size, "invalid signed payload");
        return false;
    }

    char *end = NULL;
    long long issued_at = strtoll(fields.issued_at, &end, 10);
    time_t now = time(NULL);
    if (end == NULL || *end != '\0' || issued_at < (long long)now - 60 || issued_at > (long long)now + 60) {
        free(payload_bytes);
        snprintf(error, error_size, "expired signed payload");
        return false;
    }
    if (nonce_seen(fields.nonce)) {
        free(payload_bytes);
        snprintf(error, error_size, "replayed signed payload");
        return false;
    }

    unsigned char *command_bytes = NULL;
    size_t command_length = 0;
    if (decode_base64url(fields.command, &command_bytes, &command_length) != 0 ||
        command_length == 0 || command_length > MAX_SIGNED_COMMAND_BYTES || memchr(command_bytes, '\0', command_length) != NULL) {
        free(payload_bytes);
        free(command_bytes);
        snprintf(error, error_size, "invalid command encoding");
        return false;
    }
    free(payload_bytes);
    *command = (char *)command_bytes;
    return true;
}

static int buffer_append(struct buffer *buffer, const char *data, size_t length) {
    if (buffer->length >= MAX_OUTPUT_BYTES) {
        buffer->truncated = true;
        return 0;
    }
    if (length > MAX_OUTPUT_BYTES - buffer->length) {
        length = MAX_OUTPUT_BYTES - buffer->length;
        buffer->truncated = true;
    }
    if (buffer->capacity < buffer->length + length + 1) {
        size_t capacity = (buffer->length + length + 1) * 2;
        if (capacity > MAX_OUTPUT_BYTES + 1) capacity = MAX_OUTPUT_BYTES + 1;
        char *next = realloc(buffer->data, capacity);
        if (next == NULL) return -1;
        buffer->data = next;
        buffer->capacity = capacity;
    }
    memcpy(buffer->data + buffer->length, data, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
    return 0;
}

static int64_t monotonic_milliseconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

#if !defined(WEBMINAI_PLATFORM_KUBERNETES)
static int enter_host_mount_namespace(void) {
#if defined(WEBMINAI_PLATFORM_LINUX)
    struct stat current_namespace;
    struct stat host_namespace;
    if (stat("/proc/self/ns/mnt", &current_namespace) != 0 ||
        stat("/proc/1/ns/mnt", &host_namespace) != 0) return -1;
    if (current_namespace.st_dev == host_namespace.st_dev &&
        current_namespace.st_ino == host_namespace.st_ino) return 0;

    int descriptor = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return -1;
    int result = setns(descriptor, CLONE_NEWNS);
    close(descriptor);
    return result;
#else
    return 0;
#endif
}
#endif

static void drain_fd(int fd, struct buffer *buffer, bool *open_flag) {
    char data[8192];
    for (;;) {
        ssize_t length = read(fd, data, sizeof(data));
        if (length > 0) {
            if (buffer_append(buffer, data, (size_t)length) != 0) *open_flag = false;
        } else if (length == 0) {
            close(fd);
            *open_flag = false;
            return;
        } else if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return;
        } else if (errno != EINTR) {
            close(fd);
            *open_flag = false;
            return;
        }
    }
}

#if defined(WEBMINAI_PLATFORM_KUBERNETES)
static const char *kubernetes_setting(const char *name, const char *fallback) {
    if (getuid() == geteuid()) {
        const char *value = getenv(name);
        if (value != NULL && *value != '\0') return value;
    }
    return fallback;
}

static bool valid_kubernetes_host(const char *host) {
    if (*host == '\0' || strlen(host) > 253) return false;
    for (const unsigned char *cursor = (const unsigned char *)host; *cursor != '\0'; cursor++) {
        unsigned char value = *cursor;
        if ((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
            (value >= '0' && value <= '9') || value == '.' || value == '-' || value == ':') continue;
        return false;
    }
    return true;
}

static bool valid_kubernetes_port(const char *port) {
    if (*port == '\0' || strlen(port) > 5) return false;
    long value = 0;
    for (const unsigned char *cursor = (const unsigned char *)port; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') return false;
        value = value * 10 + (*cursor - '0');
    }
    return value >= 1 && value <= 65535;
}

static char *read_bounded_text_file(const char *path, size_t maximum) {
    FILE *file = fopen(path, "r");
    if (file == NULL) return NULL;
    char *value = malloc(maximum + 1);
    if (value == NULL) {
        fclose(file);
        return NULL;
    }
    size_t length = fread(value, 1, maximum + 1, file);
    bool failed = ferror(file) || length == 0 || length > maximum;
    fclose(file);
    if (failed) {
        free(value);
        return NULL;
    }
    while (length > 0 && (value[length - 1] == '\r' || value[length - 1] == '\n')) length--;
    if (length == 0) {
        free(value);
        return NULL;
    }
    value[length] = '\0';
    return value;
}

static bool valid_kubernetes_token(const char *token) {
    for (const unsigned char *cursor = (const unsigned char *)token; *cursor != '\0'; cursor++) {
        unsigned char value = *cursor;
        if ((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
            (value >= '0' && value <= '9') || value == '.' || value == '_' || value == '-') continue;
        return false;
    }
    return *token != '\0';
}

static int run_kubernetes_request(const char *command, int timeout_seconds, struct command_result *result) {
    struct kubernetes_request request = {0};
    if (!parse_kubernetes_request(command, &request)) {
        static const char message[] = "invalid Kubernetes API request\n";
        result->exit_code = 2;
        buffer_append(&result->stderr_buffer, message, sizeof(message) - 1);
        return 0;
    }

    const char *host = kubernetes_setting("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc");
    const char *port = kubernetes_setting("KUBERNETES_SERVICE_PORT_HTTPS", "443");
    const char *token_path = kubernetes_setting(
        "WEBMINAI_KUBERNETES_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token");
    const char *ca_path = kubernetes_setting(
        "WEBMINAI_KUBERNETES_CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
    const char *curl_path = kubernetes_setting("WEBMINAI_KUBERNETES_CURL", "/usr/bin/curl");
    if (!valid_kubernetes_host(host) || !valid_kubernetes_port(port) || ca_path[0] != '/' || curl_path[0] != '/') {
        free_kubernetes_request(&request);
        static const char message[] = "invalid Kubernetes API configuration\n";
        result->exit_code = 2;
        buffer_append(&result->stderr_buffer, message, sizeof(message) - 1);
        return 0;
    }

    char *token = read_bounded_text_file(token_path, 16384);
    if (token == NULL || !valid_kubernetes_token(token)) {
        free(token);
        free_kubernetes_request(&request);
        static const char message[] = "Kubernetes service account token is unavailable\n";
        result->exit_code = 2;
        buffer_append(&result->stderr_buffer, message, sizeof(message) - 1);
        return 0;
    }

    size_t curl_config_length = strlen(token) + 38;
    char *curl_config = malloc(curl_config_length);
    size_t url_length = strlen(host) + strlen(port) + strlen(request.path) + 16;
    char *url = malloc(url_length);
    char content_header[80];
    if (curl_config == NULL || url == NULL) {
        free(token);
        free(curl_config);
        free(url);
        free_kubernetes_request(&request);
        return -1;
    }
    snprintf(curl_config, curl_config_length, "header = \"Authorization: Bearer %s\"\n", token);
    if (strchr(host, ':') != NULL) snprintf(url, url_length, "https://[%s]:%s%s", host, port, request.path);
    else snprintf(url, url_length, "https://%s:%s%s", host, port, request.path);
    snprintf(content_header, sizeof(content_header), "Content-Type: %s", request.content_type);
    OPENSSL_cleanse(token, strlen(token));
    free(token);

    int config_pipe[2] = {-1, -1};
    int stdin_pipe[2] = {-1, -1};
    int stdout_pipe[2] = {-1, -1};
    int stderr_pipe[2] = {-1, -1};
    if (pipe(config_pipe) != 0 || pipe(stdin_pipe) != 0 || pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) {
        close_pipe(config_pipe);
        close_pipe(stdin_pipe);
        close_pipe(stdout_pipe);
        close_pipe(stderr_pipe);
        OPENSSL_cleanse(curl_config, strlen(curl_config));
        free(curl_config);
        free(url);
        free_kubernetes_request(&request);
        return -1;
    }

    pid_t child = fork();
    if (child < 0) {
        close_pipe(config_pipe);
        close_pipe(stdin_pipe);
        close_pipe(stdout_pipe);
        close_pipe(stderr_pipe);
        OPENSSL_cleanse(curl_config, strlen(curl_config));
        free(curl_config);
        free(url);
        free_kubernetes_request(&request);
        return -1;
    }
    if (child == 0) {
        setpgid(0, 0);
        if (config_pipe[0] != 3) {
            dup2(config_pipe[0], 3);
            close(config_pipe[0]);
        }
        dup2(stdin_pipe[0], STDIN_FILENO);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(config_pipe[1]);
        close(stdin_pipe[0]); close(stdin_pipe[1]);
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        char timeout_value[16];
        snprintf(timeout_value, sizeof(timeout_value), "%d", timeout_seconds);
        char *const environment[] = {
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME=/",
            "LANG=C.UTF-8",
            NULL
        };
        if (request.body_length > 0) {
            execle(curl_path, "curl", "--fail-with-body", "--silent", "--show-error",
                "--max-time", timeout_value, "--request", request.method,
                "--cacert", ca_path, "--config", "/proc/self/fd/3", "--header", content_header,
                "--data-binary", "@-", url, (char *)NULL, environment);
        } else {
            execle(curl_path, "curl", "--fail-with-body", "--silent", "--show-error",
                "--max-time", timeout_value, "--request", request.method,
                "--cacert", ca_path, "--config", "/proc/self/fd/3", "--header", content_header,
                url, (char *)NULL, environment);
        }
        _exit(127);
    }

    close(config_pipe[0]);
    close(stdin_pipe[0]);
    close(stdout_pipe[1]);
    close(stderr_pipe[1]);
    size_t config_written = 0;
    size_t config_size = strlen(curl_config);
    while (config_written < config_size) {
        ssize_t count = write(config_pipe[1], curl_config + config_written, config_size - config_written);
        if (count > 0) config_written += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else break;
    }
    close(config_pipe[1]);
    size_t written = 0;
    while (written < request.body_length) {
        ssize_t count = write(stdin_pipe[1], request.body + written, request.body_length - written);
        if (count > 0) written += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else break;
    }
    close(stdin_pipe[1]);
    OPENSSL_cleanse(curl_config, strlen(curl_config));
    free(curl_config);
    free(url);
    free_kubernetes_request(&request);

    fcntl(stdout_pipe[0], F_SETFL, fcntl(stdout_pipe[0], F_GETFL) | O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, fcntl(stderr_pipe[0], F_GETFL) | O_NONBLOCK);
    bool stdout_open = true;
    bool stderr_open = true;
    bool child_exited = false;
    int status = 0;
    int64_t deadline = monotonic_milliseconds() + (int64_t)timeout_seconds * 1000;
    while (stdout_open || stderr_open || !child_exited) {
        struct pollfd descriptors[2] = {
            { stdout_pipe[0], stdout_open ? POLLIN | POLLHUP : 0, 0 },
            { stderr_pipe[0], stderr_open ? POLLIN | POLLHUP : 0, 0 }
        };
        poll(descriptors, 2, 100);
        if (stdout_open && descriptors[0].revents) drain_fd(stdout_pipe[0], &result->stdout_buffer, &stdout_open);
        if (stderr_open && descriptors[1].revents) drain_fd(stderr_pipe[0], &result->stderr_buffer, &stderr_open);
        if (!child_exited && waitpid(child, &status, WNOHANG) == child) child_exited = true;
        if (!child_exited && monotonic_milliseconds() >= deadline) {
            result->timed_out = true;
            kill(-child, SIGTERM);
            struct timespec pause = {0, 100000000};
            nanosleep(&pause, NULL);
            kill(-child, SIGKILL);
            waitpid(child, &status, 0);
            child_exited = true;
        }
    }
    if (WIFEXITED(status)) result->exit_code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) {
        result->exit_code = 128 + WTERMSIG(status);
        result->signal_number = WTERMSIG(status);
    }
    return 0;
}
#endif

#if !defined(WEBMINAI_PLATFORM_KUBERNETES)
static const char *job_root(void) {
    const char *configured = NULL;
    if (getuid() == geteuid()) configured = getenv("WEBMINAI_JOB_DIR");
    return configured != NULL && *configured != '\0' ? configured : DEFAULT_JOB_ROOT;
}

static bool valid_job_id(const char *job_id) {
    if (job_id == NULL || strlen(job_id) != 32) return false;
    for (size_t index = 0; index < 32; index++) if (hex_value(job_id[index]) < 0) return false;
    return true;
}

static bool job_file_exists(const char *path) {
    struct stat metadata;
    return stat(path, &metadata) == 0;
}

static bool job_path(char *output, size_t output_size, const char *job_id, const char *name) {
    if (!valid_job_id(job_id)) return false;
    int length = snprintf(output, output_size, "%s/%s/%s", job_root(), job_id, name);
    return length > 0 && (size_t)length < output_size;
}

static bool write_integer_file(const char *path, long value) {
    FILE *file = fopen(path, "w");
    if (file == NULL) return false;
    bool success = fprintf(file, "%ld\n", value) > 0 && fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file) != 0) success = false;
    return success;
}

static bool read_integer_file(const char *path, long *value) {
    FILE *file = fopen(path, "r");
    if (file == NULL) return false;
    bool success = fscanf(file, "%ld", value) == 1;
    fclose(file);
    return success;
}

static bool process_alive(long pid) {
    if (pid <= 1) return false;
#if defined(__linux__)
    /* kill(pid, 0) also succeeds for a zombie. A detached controller can stay
       zombie briefly under a container init, so inspect its proc state before
       deciding that a restart-recovered job is still running. */
    char path[64];
    int length = snprintf(path, sizeof(path), "/proc/%ld/stat", pid);
    if (length > 0 && (size_t)length < sizeof(path)) {
        FILE *file = fopen(path, "r");
        if (file != NULL) {
            long observed_pid = 0;
            char name[256] = {0};
            char state = '\0';
            bool parsed = fscanf(file, "%ld %255s %c", &observed_pid, name, &state) == 3;
            fclose(file);
            if (parsed && observed_pid == pid && state == 'Z') return false;
        }
    }
#endif
    if (kill((pid_t)pid, 0) == 0) return true;
    return errno == EPERM;
}

static bool finish_orphaned_job(const char *job_id, struct command_result *result) {
    char controller_path[1024];
    long controller_pid = 0;
    if (!job_path(controller_path, sizeof(controller_path), job_id, "controller.pid") ||
        !read_integer_file(controller_path, &controller_pid) || process_alive(controller_pid)) return false;

    /* Avoid racing the controller's final atomic result rename. */
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 100 * 1000 * 1000};
    while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
    if (load_job_result(job_id, result)) return true;

    char pid_path[1024];
    long command_pid = 0;
    if (job_path(pid_path, sizeof(pid_path), job_id, "pid") &&
        read_integer_file(pid_path, &command_pid) && command_pid > 1) {
        kill(-(pid_t)command_pid, SIGTERM);
    }
    static const char message[] = "detached job controller exited before recording a result";
    result->exit_code = 125;
    buffer_append(&result->stderr_buffer, message, sizeof(message) - 1);
    persist_job_result(job_id, result);
    return true;
}

static bool persist_job_result(const char *job_id, const struct command_result *result) {
    char result_path[1024];
    char temporary_path[1024];
    if (!job_path(result_path, sizeof(result_path), job_id, "result") ||
        !job_path(temporary_path, sizeof(temporary_path), job_id, "result.tmp")) return false;
    if (!persist_job_file(temporary_path, result)) return false;
    if (rename(temporary_path, result_path) == 0) return true;
    unlink(temporary_path);
    return false;
}

static bool persist_job_file(const char *path, const struct command_result *result) {
    FILE *file = fopen(path, "wb");
    if (file == NULL) return false;
    struct job_result_header header = {
        JOB_RESULT_MAGIC,
        result->exit_code,
        result->signal_number,
        (uint32_t)result->stdout_buffer.length,
        (uint32_t)result->stderr_buffer.length,
        result->timed_out,
        result->stdout_buffer.truncated,
        result->stderr_buffer.truncated
    };
    bool success = fwrite(&header, sizeof(header), 1, file) == 1;
    if (success && header.stdout_length > 0) success = fwrite(result->stdout_buffer.data, header.stdout_length, 1, file) == 1;
    if (success && header.stderr_length > 0) success = fwrite(result->stderr_buffer.data, header.stderr_length, 1, file) == 1;
    if (success) success = fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file) != 0) success = false;
    if (!success) unlink(path);
    return success;
}

static bool load_job_file(const char *path, struct command_result *result) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) return false;
    struct job_result_header header = {0};
    bool success = fread(&header, sizeof(header), 1, file) == 1 && header.magic == JOB_RESULT_MAGIC &&
        header.stdout_length <= MAX_OUTPUT_BYTES && header.stderr_length <= MAX_OUTPUT_BYTES;
    if (success && header.stdout_length > 0) {
        result->stdout_buffer.data = malloc(header.stdout_length + 1);
        success = result->stdout_buffer.data != NULL && fread(result->stdout_buffer.data, header.stdout_length, 1, file) == 1;
        if (success) result->stdout_buffer.data[header.stdout_length] = '\0';
    }
    if (success && header.stderr_length > 0) {
        result->stderr_buffer.data = malloc(header.stderr_length + 1);
        success = result->stderr_buffer.data != NULL && fread(result->stderr_buffer.data, header.stderr_length, 1, file) == 1;
        if (success) result->stderr_buffer.data[header.stderr_length] = '\0';
    }
    fclose(file);
    if (!success) {
        free(result->stdout_buffer.data);
        free(result->stderr_buffer.data);
        memset(result, 0, sizeof(*result));
        return false;
    }
    result->exit_code = header.exit_code;
    result->signal_number = header.signal_number;
    result->timed_out = header.timed_out;
    result->stdout_buffer.length = header.stdout_length;
    result->stderr_buffer.length = header.stderr_length;
    result->stdout_buffer.truncated = header.stdout_truncated;
    result->stderr_buffer.truncated = header.stderr_truncated;
    return true;
}

static bool load_job_result(const char *job_id, struct command_result *result) {
    char path[1024];
    return job_path(path, sizeof(path), job_id, "result") && load_job_file(path, result);
}

static bool create_job_id(char output[33]) {
    unsigned char bytes[16];
    int descriptor = open("/dev/urandom", O_RDONLY);
    if (descriptor < 0) return false;
    ssize_t length = read(descriptor, bytes, sizeof(bytes));
    close(descriptor);
    if (length != (ssize_t)sizeof(bytes)) return false;
    for (size_t index = 0; index < sizeof(bytes); index++) snprintf(output + index * 2, 3, "%02x", bytes[index]);
    return true;
}

#if defined(WEBMINAI_PLATFORM_LINUX)
static bool persist_job_input(const char *job_id, const char *name, const void *value, size_t length) {
    char path[1024];
    if (!job_path(path, sizeof(path), job_id, name)) return false;
    int descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) return false;
    const unsigned char *bytes = value;
    size_t written = 0;
    while (written < length) {
        ssize_t count = write(descriptor, bytes + written, length - written);
        if (count > 0) written += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else break;
    }
    bool success = written == length && fsync(descriptor) == 0;
    if (close(descriptor) != 0) success = false;
    if (!success) unlink(path);
    return success;
}
#endif

static char *load_job_command(const char *job_id, int *timeout_seconds) {
    char timeout_path[1024];
    char command_path[1024];
    long timeout = 0;
    if (!job_path(timeout_path, sizeof(timeout_path), job_id, "timeout") ||
        !job_path(command_path, sizeof(command_path), job_id, "command") ||
        !read_integer_file(timeout_path, &timeout) || timeout < 1 || timeout > MAX_JOB_TIMEOUT_SECONDS) return NULL;
    int descriptor = open(command_path, O_RDONLY | O_NOFOLLOW);
    if (descriptor < 0) return NULL;
    struct stat metadata;
    if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != 0 ||
        (metadata.st_mode & 077) != 0 || metadata.st_size < 1 || metadata.st_size > MAX_COMMAND_BYTES) {
        close(descriptor);
        return NULL;
    }
    char *command = malloc((size_t)metadata.st_size + 1);
    if (command == NULL) {
        close(descriptor);
        return NULL;
    }
    size_t consumed = 0;
    while (consumed < (size_t)metadata.st_size) {
        ssize_t count = read(descriptor, command + consumed, (size_t)metadata.st_size - consumed);
        if (count > 0) consumed += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else break;
    }
    close(descriptor);
    if (consumed != (size_t)metadata.st_size || memchr(command, '\0', consumed) != NULL) {
        OPENSSL_cleanse(command, (size_t)metadata.st_size);
        free(command);
        return NULL;
    }
    command[consumed] = '\0';
    *timeout_seconds = (int)timeout;
    return command;
}

#if defined(WEBMINAI_PLATFORM_LINUX)
static bool systemd_job_worker_available(void) {
    return geteuid() == 0 && access("/run/systemd/system", F_OK) == 0 &&
        access("/usr/bin/systemd-run", X_OK) == 0;
}

static bool launch_systemd_job_worker(const char *job_id) {
    char executable[1024];
    ssize_t executable_length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (executable_length <= 0 || (size_t)executable_length >= sizeof(executable) - 1) return false;
    executable[executable_length] = '\0';
    char unit[80];
    int unit_length = snprintf(unit, sizeof(unit), "webminai-job-%s", job_id);
    if (unit_length <= 0 || (size_t)unit_length >= sizeof(unit)) return false;
    pid_t child = fork();
    if (child < 0) return false;
    if (child == 0) {
        execl("/usr/bin/systemd-run", "systemd-run", "--quiet", "--collect", "--unit", unit,
            "--property=Type=exec", executable, "--job-worker", job_id, (char *)NULL);
        _exit(127);
    }
    int status = 0;
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
#endif

static int run_job_worker(const char *job_id) {
    if (getuid() != 0 || geteuid() != 0 || !valid_job_id(job_id)) return 126;
    char controller_path[1024];
    char command_path[1024];
    char timeout_path[1024];
    int timeout_seconds = 0;
    char *command = load_job_command(job_id, &timeout_seconds);
    if (command == NULL || !job_path(controller_path, sizeof(controller_path), job_id, "controller.pid") ||
        !write_integer_file(controller_path, getpid())) {
        if (command != NULL) OPENSSL_cleanse(command, strlen(command));
        free(command);
        return 125;
    }
    struct command_result result = {0};
    char pid_path[1024];
    if (!job_path(pid_path, sizeof(pid_path), job_id, "pid") ||
        run_command_with_pid(command, timeout_seconds, &result, pid_path) != 0) result.exit_code = 125;
    persist_job_result(job_id, &result);
    free(result.stdout_buffer.data);
    free(result.stderr_buffer.data);
    OPENSSL_cleanse(command, strlen(command));
    free(command);
    if (job_path(command_path, sizeof(command_path), job_id, "command")) unlink(command_path);
    if (job_path(timeout_path, sizeof(timeout_path), job_id, "timeout")) unlink(timeout_path);
    return 0;
}

static bool parse_job_start_request(const char *request, int *timeout_seconds, char **command) {
    const char *prefix = "timeoutSeconds=";
    const char *command_prefix = "\ncommand=";
    if (strncmp(request, prefix, strlen(prefix)) != 0) return false;
    char *end = NULL;
    long timeout = strtol(request + strlen(prefix), &end, 10);
    if (end == NULL || strncmp(end, command_prefix, strlen(command_prefix)) != 0 || timeout < 1 || timeout > MAX_JOB_TIMEOUT_SECONDS) return false;
    unsigned char *decoded = NULL;
    size_t decoded_length = 0;
    if (decode_base64url(end + strlen(command_prefix), &decoded, &decoded_length) != 0 || decoded_length == 0 ||
        decoded_length > MAX_COMMAND_BYTES || memchr(decoded, '\0', decoded_length) != NULL) {
        free(decoded);
        return false;
    }
    *timeout_seconds = (int)timeout;
    *command = (char *)decoded;
    return true;
}

static void respond_job_start_result(const char *transaction, const char *job_id) {
    respond_begin(transaction, 202);
    fputs("{\"status\":\"accepted\",\"state\":\"running\",\"jobId\":", stdout);
    json_string(job_id, strlen(job_id));
    putchar('}');
    respond_end();
}

static void respond_job_state(const char *transaction, const char *job_id, const char *state, const struct command_result *result) {
    respond_begin(transaction, 200);
    fputs("{\"status\":\"ok\",\"jobId\":", stdout);
    json_string(job_id, strlen(job_id));
    fputs(",\"state\":", stdout);
    json_string(state, strlen(state));
    if (result != NULL) {
        printf(",\"exitCode\":%d,\"signal\":%d,\"timedOut\":%s,\"outputEncoding\":\"base64\",\"stdout\":",
            result->exit_code, result->signal_number, result->timed_out ? "true" : "false");
        json_base64(result->stdout_buffer.data == NULL ? "" : result->stdout_buffer.data, result->stdout_buffer.length);
        fputs(",\"stderr\":", stdout);
        json_base64(result->stderr_buffer.data == NULL ? "" : result->stderr_buffer.data, result->stderr_buffer.length);
        printf(",\"stdoutTruncated\":%s,\"stderrTruncated\":%s",
            result->stdout_buffer.truncated ? "true" : "false", result->stderr_buffer.truncated ? "true" : "false");
    }
    putchar('}');
    respond_end();
}

static void handle_job_start(const char *transaction, const char *request) {
    int timeout_seconds = 0;
    char *command = NULL;
    if (!parse_job_start_request(request, &timeout_seconds, &command)) {
        respond_error(transaction, 400, "invalid job start request");
        return;
    }
    const char *root = job_root();
    if (mkdir(root, 0700) != 0 && errno != EEXIST) {
        free(command);
        respond_error(transaction, 500, "could not create job storage");
        return;
    }
    char job_id[33] = {0};
    char directory[1024];
    bool created = false;
    for (size_t attempt = 0; attempt < 8 && !created; attempt++) {
        if (!create_job_id(job_id)) break;
        int length = snprintf(directory, sizeof(directory), "%s/%s", root, job_id);
        if (length > 0 && (size_t)length < sizeof(directory) && mkdir(directory, 0700) == 0) created = true;
    }
    if (!created) {
        free(command);
        respond_error(transaction, 500, "could not allocate job storage");
        return;
    }
#if defined(WEBMINAI_PLATFORM_LINUX)
    if (systemd_job_worker_available()) {
        char timeout_value[32];
        int timeout_length = snprintf(timeout_value, sizeof(timeout_value), "%d\n", timeout_seconds);
        bool persisted = timeout_length > 0 && (size_t)timeout_length < sizeof(timeout_value) &&
            persist_job_input(job_id, "command", command, strlen(command)) &&
            persist_job_input(job_id, "timeout", timeout_value, (size_t)timeout_length);
        if (!persisted || !launch_systemd_job_worker(job_id)) {
            char input_path[1024];
            if (job_path(input_path, sizeof(input_path), job_id, "command")) unlink(input_path);
            if (job_path(input_path, sizeof(input_path), job_id, "timeout")) unlink(input_path);
            rmdir(directory);
            OPENSSL_cleanse(command, strlen(command));
            free(command);
            respond_error(transaction, 500, "could not start isolated job worker");
            return;
        }
        OPENSSL_cleanse(command, strlen(command));
        free(command);
        respond_job_start_result(transaction, job_id);
        return;
    }
#endif
    pid_t launcher = fork();
    if (launcher < 0) {
        rmdir(directory);
        free(command);
        respond_error(transaction, 500, "could not start job controller");
        return;
    }
    if (launcher == 0) {
        pid_t controller = fork();
        if (controller < 0) _exit(1);
        if (controller > 0) {
            char controller_path[1024];
            if (!job_path(controller_path, sizeof(controller_path), job_id, "controller.pid") ||
                !write_integer_file(controller_path, controller)) {
                kill(controller, SIGKILL);
                _exit(1);
            }
            _exit(0);
        }
        setsid();
        int null_descriptor = open("/dev/null", O_RDWR);
        if (null_descriptor >= 0) {
            dup2(null_descriptor, STDIN_FILENO);
            dup2(null_descriptor, STDOUT_FILENO);
            dup2(null_descriptor, STDERR_FILENO);
            if (null_descriptor > STDERR_FILENO) close(null_descriptor);
        }
        char pid_path[1024];
        struct command_result result = {0};
        if (!job_path(pid_path, sizeof(pid_path), job_id, "pid") ||
            run_command_with_pid(command, timeout_seconds, &result, pid_path) != 0) {
            result.exit_code = 125;
        }
        persist_job_result(job_id, &result);
        free(result.stdout_buffer.data);
        free(result.stderr_buffer.data);
        free(command);
        _exit(0);
    }
    int launcher_status = 0;
    while (waitpid(launcher, &launcher_status, 0) < 0 && errno == EINTR) {}
    free(command);
    if (!WIFEXITED(launcher_status) || WEXITSTATUS(launcher_status) != 0) {
        char controller_path[1024];
        if (job_path(controller_path, sizeof(controller_path), job_id, "controller.pid")) unlink(controller_path);
        rmdir(directory);
        respond_error(transaction, 500, "could not detach job controller");
        return;
    }
    respond_job_start_result(transaction, job_id);
}

static void handle_job_status(const char *transaction, const char *job_id) {
    if (!valid_job_id(job_id)) {
        respond_error(transaction, 400, "invalid job id");
        return;
    }
    struct command_result result = {0};
    if (load_job_result(job_id, &result)) {
        char cancel_path[1024];
        bool cancelled = job_path(cancel_path, sizeof(cancel_path), job_id, "cancelled") && job_file_exists(cancel_path);
        const char *state = cancelled ? "cancelled" : result.timed_out ? "timed_out" : result.exit_code == 0 ? "succeeded" : "failed";
        respond_job_state(transaction, job_id, state, &result);
        free(result.stdout_buffer.data);
        free(result.stderr_buffer.data);
        return;
    }
    char directory[1024];
    int length = snprintf(directory, sizeof(directory), "%s/%s", job_root(), job_id);
    if (length <= 0 || (size_t)length >= sizeof(directory) || !job_file_exists(directory)) {
        respond_error(transaction, 404, "job not found");
        return;
    }
    if (finish_orphaned_job(job_id, &result)) {
        respond_job_state(transaction, job_id, result.exit_code == 0 ? "succeeded" : "failed", &result);
        free(result.stdout_buffer.data);
        free(result.stderr_buffer.data);
        return;
    }
    char cancel_path[1024];
    char progress_path[1024];
    bool cancelling = job_path(cancel_path, sizeof(cancel_path), job_id, "cancelled") && job_file_exists(cancel_path);
    struct command_result progress = {0};
    bool has_progress = job_path(progress_path, sizeof(progress_path), job_id, "progress") && load_job_file(progress_path, &progress);
    respond_job_state(transaction, job_id, cancelling ? "cancelling" : "running", has_progress ? &progress : NULL);
    free(progress.stdout_buffer.data);
    free(progress.stderr_buffer.data);
}

static void handle_job_cancel(const char *transaction, const char *job_id) {
    char pid_path[1024];
    char cancel_path[1024];
    if (!job_path(pid_path, sizeof(pid_path), job_id, "pid") || !job_path(cancel_path, sizeof(cancel_path), job_id, "cancelled")) {
        respond_error(transaction, 400, "invalid job id");
        return;
    }
    struct command_result result = {0};
    if (load_job_result(job_id, &result)) {
        free(result.stdout_buffer.data);
        free(result.stderr_buffer.data);
        respond_job_state(transaction, job_id, "completed", NULL);
        return;
    }
    char directory[1024];
    int directory_length = snprintf(directory, sizeof(directory), "%s/%s", job_root(), job_id);
    if (directory_length <= 0 || (size_t)directory_length >= sizeof(directory) || !job_file_exists(directory)) {
        respond_error(transaction, 404, "job not found");
        return;
    }
    int descriptor = open(cancel_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor >= 0) close(descriptor);
    long pid = 0;
    if (read_integer_file(pid_path, &pid) && pid > 1) kill(-(pid_t)pid, SIGTERM);
    respond_job_state(transaction, job_id, "cancelling", NULL);
}

static void handle_job_cleanup(const char *transaction, const char *job_id) {
    struct command_result result = {0};
    if (!valid_job_id(job_id)) {
        respond_error(transaction, 400, "invalid job id");
        return;
    }
    if (!load_job_result(job_id, &result)) {
        respond_error(transaction, 409, "job is still running");
        return;
    }
    free(result.stdout_buffer.data);
    free(result.stderr_buffer.data);
    const char *files[] = {"result", "result.tmp", "progress", "progress.tmp", "pid", "controller.pid", "command", "timeout", "cancelled"};
    char path[1024];
    for (size_t index = 0; index < sizeof(files) / sizeof(files[0]); index++) {
        if (job_path(path, sizeof(path), job_id, files[index])) unlink(path);
    }
    int length = snprintf(path, sizeof(path), "%s/%s", job_root(), job_id);
    if (length > 0 && (size_t)length < sizeof(path)) rmdir(path);
    respond_job_state(transaction, job_id, "cleaned", NULL);
}
#endif

static int run_command(const char *command, int timeout_seconds, struct command_result *result) {
    return run_command_with_pid(command, timeout_seconds, result, NULL);
}

static int run_command_with_pid(const char *command, int timeout_seconds, struct command_result *result, const char *pid_file) {
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
    (void)pid_file;
    return run_kubernetes_request(command, timeout_seconds, result);
#else
    int stdout_pipe[2];
    int stderr_pipe[2];
    if (pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) return -1;

    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        setpgid(0, 0);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        if (geteuid() == 0) {
            if (enter_host_mount_namespace() != 0) {
                static const char message[] = "webminai.plugin: could not enter the host mount namespace\n";
                write(STDERR_FILENO, message, sizeof(message) - 1);
                _exit(126);
            }
            if (setgroups(0, NULL) != 0 || setgid(0) != 0 || setuid(0) != 0) _exit(126);
        }
        const char *shell_path = "/bin/sh";
        const char *shell_name = "sh";
#if defined(WEBMINAI_PLATFORM_LINUX)
        shell_path = "/bin/bash";
        shell_name = "bash";
        if (access(shell_path, X_OK) != 0) {
            shell_path = "/opt/netdata/bin/bash";
            if (access(shell_path, X_OK) != 0) {
                shell_path = "/bin/sh";
                shell_name = "sh";
            }
        }
#endif
        char shell_environment[256];
        snprintf(shell_environment, sizeof(shell_environment), "SHELL=%s", shell_path);
        char *const environment[] = {
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME=/root",
            "USER=root",
            "LOGNAME=root",
            shell_environment,
            "LANG=C.UTF-8",
            NULL
        };
        execle(shell_path, shell_name, "-c", command, (char *)NULL, environment);
        _exit(127);
    }

    if (pid_file != NULL && !write_integer_file(pid_file, child)) {
        kill(-child, SIGKILL);
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        return -1;
    }

    close(stdout_pipe[1]);
    close(stderr_pipe[1]);
    fcntl(stdout_pipe[0], F_SETFL, fcntl(stdout_pipe[0], F_GETFL) | O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, fcntl(stderr_pipe[0], F_GETFL) | O_NONBLOCK);

    bool stdout_open = true;
    bool stderr_open = true;
    bool child_exited = false;
    int status = 0;
    int64_t deadline = monotonic_milliseconds() + (int64_t)timeout_seconds * 1000;
    int64_t next_snapshot = monotonic_milliseconds();
    char progress_path[1024] = {0};
    char progress_temporary_path[1024] = {0};
    char cancel_path[1024] = {0};
    if (pid_file != NULL) {
        size_t path_length = strlen(pid_file);
        if (path_length > 3 && strcmp(pid_file + path_length - 3, "pid") == 0) {
            snprintf(progress_path, sizeof(progress_path), "%.*sprogress", (int)(path_length - 3), pid_file);
            snprintf(progress_temporary_path, sizeof(progress_temporary_path), "%.*sprogress.tmp", (int)(path_length - 3), pid_file);
            snprintf(cancel_path, sizeof(cancel_path), "%.*scancelled", (int)(path_length - 3), pid_file);
        }
    }

    while (stdout_open || stderr_open || !child_exited) {
        struct pollfd descriptors[2] = {
            { stdout_pipe[0], stdout_open ? POLLIN | POLLHUP : 0, 0 },
            { stderr_pipe[0], stderr_open ? POLLIN | POLLHUP : 0, 0 }
        };
        poll(descriptors, 2, 100);
        if (stdout_open && descriptors[0].revents) drain_fd(stdout_pipe[0], &result->stdout_buffer, &stdout_open);
        if (stderr_open && descriptors[1].revents) drain_fd(stderr_pipe[0], &result->stderr_buffer, &stderr_open);

        if (!child_exited) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child) child_exited = true;
        }
        if (!child_exited && cancel_path[0] != '\0' && job_file_exists(cancel_path)) {
            kill(-child, SIGTERM);
            struct timespec pause = {0, 100000000};
            nanosleep(&pause, NULL);
            kill(-child, SIGKILL);
            waitpid(child, &status, 0);
            child_exited = true;
        }
        if (progress_path[0] != '\0' && monotonic_milliseconds() >= next_snapshot) {
            if (persist_job_file(progress_temporary_path, result)) rename(progress_temporary_path, progress_path);
            next_snapshot = monotonic_milliseconds() + 500;
        }
        if (child_exited) {
            /* The approved shell owns foreground-command completion. A deliberately
             * detached descendant may inherit a pipe even after that shell exits;
             * drain bytes already available, then close our readers so it cannot
             * hold the Netdata function open until its timeout. */
            if (stdout_open) {
                drain_fd(stdout_pipe[0], &result->stdout_buffer, &stdout_open);
                if (stdout_open) {
                    close(stdout_pipe[0]);
                    stdout_open = false;
                }
            }
            if (stderr_open) {
                drain_fd(stderr_pipe[0], &result->stderr_buffer, &stderr_open);
                if (stderr_open) {
                    close(stderr_pipe[0]);
                    stderr_open = false;
                }
            }
        }
        if (!child_exited && monotonic_milliseconds() >= deadline) {
            result->timed_out = true;
            kill(-child, SIGTERM);
            struct timespec pause = {0, 100000000};
            nanosleep(&pause, NULL);
            kill(-child, SIGKILL);
            waitpid(child, &status, 0);
            child_exited = true;
        }
    }

    if (progress_path[0] != '\0' && persist_job_file(progress_temporary_path, result)) rename(progress_temporary_path, progress_path);

    if (WIFEXITED(status)) result->exit_code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) {
        result->exit_code = 128 + WTERMSIG(status);
        result->signal_number = WTERMSIG(status);
    }
    return 0;
#endif
}

static void json_string(const char *value, size_t length) {
    putchar('"');
    for (size_t index = 0; index < length; index++) {
        unsigned char byte = (unsigned char)value[index];
        switch (byte) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b", stdout); break;
            case '\f': fputs("\\f", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (byte < 0x20) printf("\\u%04x", byte);
                else putchar(byte);
        }
    }
    putchar('"');
}

static void json_base64(const char *value, size_t length) {
    if (length == 0) {
        fputs("\"\"", stdout);
        return;
    }
    size_t encoded_length = ((length + 2) / 3) * 4;
    unsigned char *encoded = malloc(encoded_length + 1);
    if (encoded == NULL) {
        fputs("\"\"", stdout);
        return;
    }
#if defined(WEBMINAI_PLATFORM_MACOS)
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t output = 0;
    for (size_t index = 0; index < length; index += 3) {
        unsigned int block = (unsigned char)value[index] << 16;
        if (index + 1 < length) block |= (unsigned char)value[index + 1] << 8;
        if (index + 2 < length) block |= (unsigned char)value[index + 2];
        encoded[output++] = alphabet[(block >> 18) & 63];
        encoded[output++] = alphabet[(block >> 12) & 63];
        encoded[output++] = index + 1 < length ? alphabet[(block >> 6) & 63] : '=';
        encoded[output++] = index + 2 < length ? alphabet[block & 63] : '=';
    }
#else
    EVP_EncodeBlock(encoded, (const unsigned char *)value, (int)length);
#endif
    json_string((const char *)encoded, encoded_length);
    free(encoded);
}

static void respond_begin(const char *transaction, int status) {
    printf("FUNCTION_RESULT_BEGIN %s %d application/json 0\n", transaction, status);
}

static void respond_end(void) {
    printf("\nFUNCTION_RESULT_END\n");
    fflush(stdout);
}

static void respond_error(const char *transaction, int status, const char *message) {
    respond_begin(transaction, status);
    fputs("{\"status\":", stdout);
    printf("%d,\"error\":", status);
    json_string(message, strlen(message));
    putchar('}');
    respond_end();
}

static void respond_health(const char *transaction) {
    respond_begin(transaction, 200);
    printf("{\"status\":\"ok\",\"plugin\":\"webminai\",\"version\":\"%s\",\"platform\":\"%s\",\"effectiveUid\":%ld",
        WEBMINAI_PLUGIN_VERSION, WEBMINAI_PLATFORM_NAME, (long)geteuid());
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
    fputs(",\"executionMode\":\"kubernetes-api\"", stdout);
#else
    fputs(",\"executionMode\":\"host-root\"", stdout);
#endif
    putchar('}');
    respond_end();
}

static void respond_command(const char *transaction, const struct command_result *result) {
    respond_begin(transaction, 200);
    printf("{\"status\":\"completed\",\"exitCode\":%d,\"signal\":%d,\"timedOut\":%s,\"outputEncoding\":\"base64\",\"stdout\":",
        result->exit_code, result->signal_number, result->timed_out ? "true" : "false");
    json_base64(result->stdout_buffer.data == NULL ? "" : result->stdout_buffer.data, result->stdout_buffer.length);
    fputs(",\"stderr\":", stdout);
    json_base64(result->stderr_buffer.data == NULL ? "" : result->stderr_buffer.data, result->stderr_buffer.length);
    printf(",\"stdoutTruncated\":%s,\"stderrTruncated\":%s}",
        result->stdout_buffer.truncated ? "true" : "false",
        result->stderr_buffer.truncated ? "true" : "false");
    respond_end();
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(WEBMINAI_PLUGIN_VERSION);
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--platform") == 0) {
        puts(WEBMINAI_PLATFORM_NAME);
        return 0;
    }
#if !defined(WEBMINAI_PLATFORM_KUBERNETES)
    if (argc == 3 && strcmp(argv[1], "--job-worker") == 0) return run_job_worker(argv[2]);
#endif
#if defined(WEBMINAI_PLATFORM_KUBERNETES)
    signal(SIGPIPE, SIG_IGN);
#endif
    return plugin_loop();
}
