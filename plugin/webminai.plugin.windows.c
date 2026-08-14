#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>
#include <limits.h>
#include <sddl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef WEBMINAI_PLUGIN_VERSION
#define WEBMINAI_PLUGIN_VERSION "0.0.0-dev"
#endif

#define DEFAULT_KEY_FILE L"C:\\ProgramData\\WebminAI\\action.key"
#define DEFAULT_JOB_ROOT L"C:\\ProgramData\\WebminAI\\jobs"
#define MAX_REQUEST_BYTES (128 * 1024)
#define MAX_COMMAND_BYTES (32 * 1024)
#define MAX_OUTPUT_BYTES (64 * 1024)
#define MAX_REPLAY_NONCES 256
#define SHA256_BYTES 32
#define MAX_CONCURRENT_JOBS 4
#define MAX_RETAINED_JOBS 64
#define MAX_JOB_STORAGE_BYTES (256ULL * 1024ULL * 1024ULL)
#define MAX_JOB_TIMEOUT_SECONDS 86400
#define JOB_RESULT_MAGIC 0x574d4a31U

struct buffer {
    char *data;
    size_t length;
    size_t capacity;
    bool truncated;
};

struct command_result {
    int exit_code;
    bool timed_out;
    struct buffer stdout_buffer;
    struct buffer stderr_buffer;
};

struct reader_context {
    HANDLE handle;
    struct buffer *buffer;
};

struct signed_payload_fields {
    char *version;
    char *issued_at;
    char *request_id;
    char *nonce;
    char *command;
};

struct job_result_header {
    uint32_t magic;
    int32_t exit_code;
    uint32_t flags;
    uint32_t stdout_length;
    uint32_t stderr_length;
};

struct job_identity {
    DWORD pid;
    uint64_t creation_time;
};

static char replay_nonces[MAX_REPLAY_NONCES][65];
static size_t replay_index;

static void respond_error(const char *transaction, int status, const char *message);
static void respond_health(const char *transaction);
static void respond_command(const char *transaction, const struct command_result *result);
static void respond_begin(const char *transaction, int status);
static void respond_end(void);
static void json_base64(const char *value, size_t length);
static void handle_job_start(const char *transaction, const char *request);
static void handle_job_status(const char *transaction, const char *job_id);
static void handle_job_cancel(const char *transaction, const char *job_id);
static void handle_job_cleanup(const char *transaction, const char *job_id);
static bool verify_request(const char *body, char **command, char *error, size_t error_size);
static int run_command(const char *command, int timeout_seconds, struct command_result *result);
static int job_worker_main(const char *job_id, int timeout_seconds);
static int cancel_all_jobs(void);

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
        char *next = (char *)realloc(buffer->data, capacity);
        if (next == NULL) return -1;
        buffer->data = next;
        buffer->capacity = capacity;
    }
    if (length > 0) memcpy(buffer->data + buffer->length, data, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
    return 0;
}

static void append_windows_error(struct buffer *buffer, const char *operation, DWORD code) {
    char message[512] = {0};
    DWORD length = FormatMessageA(
        FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), message, (DWORD)sizeof(message), NULL);
    if (length == 0) snprintf(message, sizeof(message), "Windows error %lu", (unsigned long)code);
    char combined[640];
    int written = snprintf(combined, sizeof(combined), "%s: %s", operation, message);
    if (written > 0) buffer_append(buffer, combined, (size_t)written < sizeof(combined) ? (size_t)written : sizeof(combined) - 1);
}

static int base64_value(unsigned char value) {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    if (value == '+' || value == '-') return 62;
    if (value == '/' || value == '_') return 63;
    return -1;
}

static int decode_base64url(const char *input, unsigned char **output, size_t *output_length) {
    size_t length = strlen(input);
    if (length == 0 || length % 4 == 1) return -1;
    size_t capacity = (length / 4 + 1) * 3;
    unsigned char *decoded = (unsigned char *)malloc(capacity + 1);
    if (decoded == NULL) return -1;
    unsigned int accumulator = 0;
    int bits = 0;
    size_t written = 0;
    for (size_t index = 0; index < length; index++) {
        int value = base64_value((unsigned char)input[index]);
        if (value < 0) {
            free(decoded);
            return -1;
        }
        accumulator = (accumulator << 6) | (unsigned int)value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            decoded[written++] = (unsigned char)((accumulator >> bits) & 0xffU);
        }
    }
    if (bits > 0 && (accumulator & ((1U << bits) - 1U)) != 0) {
        free(decoded);
        return -1;
    }
    decoded[written] = '\0';
    *output = decoded;
    *output_length = written;
    return 0;
}

static const char base64_alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *encode_base64(const unsigned char *input, size_t length, size_t *encoded_length) {
    size_t output_length = ((length + 2) / 3) * 4;
    char *output = (char *)malloc(output_length + 1);
    if (output == NULL) return NULL;
    size_t source = 0;
    size_t target = 0;
    while (source < length) {
        size_t remaining = length - source;
        uint32_t value = (uint32_t)input[source++] << 16;
        if (remaining > 1) value |= (uint32_t)input[source++] << 8;
        if (remaining > 2) value |= input[source++];
        output[target++] = base64_alphabet[(value >> 18) & 0x3fU];
        output[target++] = base64_alphabet[(value >> 12) & 0x3fU];
        output[target++] = remaining > 1 ? base64_alphabet[(value >> 6) & 0x3fU] : '=';
        output[target++] = remaining > 2 ? base64_alphabet[value & 0x3fU] : '=';
    }
    output[target] = '\0';
    *encoded_length = target;
    return output;
}

static int hex_value(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

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

static bool read_key(unsigned char key[32]) {
    wchar_t path[MAX_PATH * 2];
    DWORD length = GetEnvironmentVariableW(L"WEBMINAI_KEY_FILE", path, (DWORD)(sizeof(path) / sizeof(path[0])));
    if (length == 0) wcscpy(path, DEFAULT_KEY_FILE);
    else if (length >= sizeof(path) / sizeof(path[0])) return false;
    FILE *file = _wfopen(path, L"rb");
    if (file == NULL) return false;
    char hex[67] = {0};
    size_t length_read = fread(hex, 1, sizeof(hex) - 1, file);
    bool success = !ferror(file) && fgetc(file) == EOF;
    fclose(file);
    while (length_read > 0 && (hex[length_read - 1] == '\r' || hex[length_read - 1] == '\n')) {
        hex[--length_read] = '\0';
    }
    return success && length_read == 64 && decode_hex(hex, key, 32);
}

static bool hmac_sha256(const unsigned char key[32], const unsigned char *data, size_t data_length,
                        unsigned char output[SHA256_BYTES]) {
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    PUCHAR object = NULL;
    DWORD object_length = 0;
    DWORD result_length = 0;
    bool success = false;
    NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG);
    if (status < 0) goto cleanup;
    status = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_length,
        sizeof(object_length), &result_length, 0);
    if (status < 0 || object_length == 0) goto cleanup;
    object = (PUCHAR)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, object_length);
    if (object == NULL) goto cleanup;
    status = BCryptCreateHash(algorithm, &hash, object, object_length, (PUCHAR)key, 32, 0);
    if (status < 0) goto cleanup;
    if (data_length > ULONG_MAX) goto cleanup;
    status = BCryptHashData(hash, (PUCHAR)data, (ULONG)data_length, 0);
    if (status < 0) goto cleanup;
    status = BCryptFinishHash(hash, output, SHA256_BYTES, 0);
    success = status >= 0;

cleanup:
    if (hash != NULL) BCryptDestroyHash(hash);
    if (object != NULL) {
        SecureZeroMemory(object, object_length);
        HeapFree(GetProcessHeap(), 0, object);
    }
    if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
    return success;
}

static bool constant_time_equal(const unsigned char *left, const unsigned char *right, size_t length) {
    unsigned char difference = 0;
    for (size_t index = 0; index < length; index++) difference |= left[index] ^ right[index];
    return difference == 0;
}

static int64_t unix_time_seconds(void) {
    FILETIME file_time;
    ULARGE_INTEGER value;
    GetSystemTimeAsFileTime(&file_time);
    value.LowPart = file_time.dwLowDateTime;
    value.HighPart = file_time.dwHighDateTime;
    return (int64_t)(value.QuadPart / 10000000ULL) - 11644473600LL;
}

static bool extract_wrapper(const char *body, char **payload, char mac[65]) {
    const char *prefix = "{\"payload\":\"";
    const char *middle = "\",\"mac\":\"";
    size_t body_length = strlen(body);
    while (body_length > 0 && (body[body_length - 1] == '\n' || body[body_length - 1] == '\r')) body_length--;
    if (strncmp(body, prefix, strlen(prefix)) != 0) return false;
    const char *middle_position = strstr(body + strlen(prefix), middle);
    if (middle_position == NULL) return false;
    const char *mac_start = middle_position + strlen(middle);
    if ((size_t)(mac_start - body) + 66 != body_length || mac_start[64] != '"' || mac_start[65] != '}') return false;
    for (size_t index = 0; index < 64; index++) {
        if (hex_value(mac_start[index]) < 0) return false;
        mac[index] = mac_start[index];
    }
    mac[64] = '\0';
    size_t payload_length = (size_t)(middle_position - (body + strlen(prefix)));
    *payload = (char *)malloc(payload_length + 1);
    if (*payload == NULL) return false;
    memcpy(*payload, body + strlen(prefix), payload_length);
    (*payload)[payload_length] = '\0';
    return true;
}

static bool parse_signed_payload(char *payload, struct signed_payload_fields *fields) {
    char *cursor = payload;
    while (*cursor != '\0') {
        char *line = cursor;
        char *newline = strchr(cursor, '\n');
        if (newline != NULL) {
            *newline = '\0';
            cursor = newline + 1;
        } else cursor += strlen(cursor);
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
    unsigned char expected[SHA256_BYTES] = {0};
    unsigned char supplied[SHA256_BYTES] = {0};
    if (!read_key(key) || !decode_hex(mac_hex, supplied, sizeof(supplied))) {
        SecureZeroMemory(key, sizeof(key));
        free(payload_bytes);
        snprintf(error, error_size, "command authentication is unavailable");
        return false;
    }
    bool authenticated = hmac_sha256(key, payload_bytes, payload_length, expected);
    SecureZeroMemory(key, sizeof(key));
    if (!authenticated || !constant_time_equal(expected, supplied, sizeof(expected))) {
        SecureZeroMemory(expected, sizeof(expected));
        free(payload_bytes);
        snprintf(error, error_size, "invalid command signature");
        return false;
    }
    SecureZeroMemory(expected, sizeof(expected));
    struct signed_payload_fields fields = {0};
    if (!parse_signed_payload((char *)payload_bytes, &fields) || strcmp(fields.version, "1") != 0 ||
        strlen(fields.nonce) > 64 || strlen(fields.request_id) > 64) {
        free(payload_bytes);
        snprintf(error, error_size, "invalid signed payload");
        return false;
    }
    char *end = NULL;
    long long issued_at = strtoll(fields.issued_at, &end, 10);
    int64_t now = unix_time_seconds();
    if (end == NULL || *end != '\0' || issued_at < now - 60 || issued_at > now + 60) {
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
        command_length == 0 || command_length > MAX_COMMAND_BYTES || memchr(command_bytes, '\0', command_length) != NULL) {
        free(payload_bytes);
        free(command_bytes);
        snprintf(error, error_size, "invalid command encoding");
        return false;
    }
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)command_bytes,
            (int)command_length, NULL, 0) == 0) {
        free(payload_bytes);
        SecureZeroMemory(command_bytes, command_length);
        free(command_bytes);
        snprintf(error, error_size, "command is not valid UTF-8");
        return false;
    }
    free(payload_bytes);
    *command = (char *)command_bytes;
    return true;
}

static DWORD WINAPI reader_thread(LPVOID parameter) {
    struct reader_context *context = (struct reader_context *)parameter;
    char data[4096];
    DWORD length = 0;
    while (ReadFile(context->handle, data, sizeof(data), &length, NULL) && length > 0) {
        if (buffer_append(context->buffer, data, length) != 0) break;
    }
    CloseHandle(context->handle);
    context->handle = NULL;
    return 0;
}

static wchar_t *build_environment(const wchar_t *windows_directory, const wchar_t *program_data,
                                  const wchar_t *program_files, size_t *environment_chars) {
    size_t capacity = wcslen(windows_directory) * 7 + wcslen(program_data) + wcslen(program_files) + 640;
    wchar_t *environment = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (environment == NULL) return NULL;
    wchar_t *cursor = environment;
    size_t remaining = capacity;
#define APPEND_ENVIRONMENT(...) do { \
        int written = swprintf(cursor, remaining, __VA_ARGS__); \
        if (written < 0 || (size_t)written + 1 > remaining) { \
            SecureZeroMemory(environment, capacity * sizeof(wchar_t)); \
            free(environment); \
            return NULL; \
        } \
        cursor += written + 1; \
        remaining -= (size_t)written + 1; \
    } while (0)
    APPEND_ENVIRONMENT(L"ComSpec=%ls\\System32\\cmd.exe", windows_directory);
    APPEND_ENVIRONMENT(L"PATH=%ls\\System32;%ls\\System32\\WindowsPowerShell\\v1.0",
        windows_directory, windows_directory);
    APPEND_ENVIRONMENT(L"ProgramData=%ls", program_data);
    APPEND_ENVIRONMENT(L"ProgramFiles=%ls", program_files);
    APPEND_ENVIRONMENT(L"SystemRoot=%ls", windows_directory);
    APPEND_ENVIRONMENT(L"TEMP=%ls\\Temp", windows_directory);
    APPEND_ENVIRONMENT(L"TMP=%ls\\Temp", windows_directory);
    APPEND_ENVIRONMENT(L"WEBMINAI_EXECUTION=1");
    APPEND_ENVIRONMENT(L"windir=%ls", windows_directory);
#undef APPEND_ENVIRONMENT
    *cursor = L'\0';
    *environment_chars = (size_t)(cursor - environment) + 1;
    return environment;
}

static int run_command(const char *command, int timeout_seconds, struct command_result *result) {
    SECURITY_ATTRIBUTES pipe_security = {sizeof(pipe_security), NULL, FALSE};
    PSECURITY_DESCRIPTOR pipe_descriptor = NULL;
    HANDLE stdin_write = NULL;
    HANDLE stdout_read = NULL;
    HANDLE stderr_read = NULL;
    HANDLE job = NULL;
    HANDLE stdout_thread = NULL, stderr_thread = NULL;
    PROCESS_INFORMATION process = {0};
    STARTUPINFOW startup = {0};
    wchar_t windows_directory[MAX_PATH];
    wchar_t system_directory[MAX_PATH];
    wchar_t program_data[MAX_PATH];
    wchar_t program_files[MAX_PATH];
    wchar_t executable[MAX_PATH * 2];
    wchar_t command_line[2048];
    wchar_t *environment = NULL;
    size_t environment_chars = 0;
    int status = -1;
    bool process_suspended = true;
    wchar_t stdin_name[128];
    wchar_t stdout_name[128];
    wchar_t stderr_name[128];
    static LONG pipe_sequence = 0;

    result->exit_code = 127;
    UINT windows_length = GetWindowsDirectoryW(windows_directory, MAX_PATH);
    UINT system_length = GetSystemDirectoryW(system_directory, MAX_PATH);
    DWORD program_data_length = GetEnvironmentVariableW(L"ProgramData", program_data, MAX_PATH);
    DWORD program_files_length = GetEnvironmentVariableW(L"ProgramFiles", program_files, MAX_PATH);
    if (windows_length == 0 || windows_length >= MAX_PATH || system_length == 0 || system_length >= MAX_PATH ||
        program_data_length == 0 || program_data_length >= MAX_PATH ||
        program_files_length == 0 || program_files_length >= MAX_PATH) {
        append_windows_error(&result->stderr_buffer, "locate Windows directories", GetLastError());
        goto cleanup;
    }
    _snwprintf(executable, sizeof(executable) / sizeof(executable[0]),
        L"%ls\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", windows_directory);
    LONG sequence = InterlockedIncrement(&pipe_sequence);
    _snwprintf(stdin_name, sizeof(stdin_name) / sizeof(stdin_name[0]),
        L"webminai-%lu-%ld-in", (unsigned long)GetCurrentProcessId(), (long)sequence);
    _snwprintf(stdout_name, sizeof(stdout_name) / sizeof(stdout_name[0]),
        L"webminai-%lu-%ld-out", (unsigned long)GetCurrentProcessId(), (long)sequence);
    _snwprintf(stderr_name, sizeof(stderr_name) / sizeof(stderr_name[0]),
        L"webminai-%lu-%ld-err", (unsigned long)GetCurrentProcessId(), (long)sequence);
    _snwprintf(command_line, sizeof(command_line) / sizeof(command_line[0]),
        L"powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "
        L"\"%ls\\WebminAI\\command-runner.ps1\" %ls %ls %ls",
        program_data, stdin_name, stdout_name, stderr_name);
    environment = build_environment(windows_directory, program_data, program_files, &environment_chars);
    if (environment == NULL) goto cleanup;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1, &pipe_descriptor, NULL)) {
        append_windows_error(&result->stderr_buffer, "create PowerShell pipe security", GetLastError());
        goto cleanup;
    }
    pipe_security.lpSecurityDescriptor = pipe_descriptor;
    wchar_t pipe_path[160];
    _snwprintf(pipe_path, sizeof(pipe_path) / sizeof(pipe_path[0]), L"\\\\.\\pipe\\%ls", stdin_name);
    stdin_write = CreateNamedPipeW(pipe_path, PIPE_ACCESS_OUTBOUND,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 10000, &pipe_security);
    _snwprintf(pipe_path, sizeof(pipe_path) / sizeof(pipe_path[0]), L"\\\\.\\pipe\\%ls", stdout_name);
    stdout_read = CreateNamedPipeW(pipe_path, PIPE_ACCESS_INBOUND,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 10000, &pipe_security);
    _snwprintf(pipe_path, sizeof(pipe_path) / sizeof(pipe_path[0]), L"\\\\.\\pipe\\%ls", stderr_name);
    stderr_read = CreateNamedPipeW(pipe_path, PIPE_ACCESS_INBOUND,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 10000, &pipe_security);
    if (stdin_write == INVALID_HANDLE_VALUE || stdout_read == INVALID_HANDLE_VALUE || stderr_read == INVALID_HANDLE_VALUE) {
        append_windows_error(&result->stderr_buffer, "create PowerShell named pipes", GetLastError());
        if (stdin_write == INVALID_HANDLE_VALUE) stdin_write = NULL;
        if (stdout_read == INVALID_HANDLE_VALUE) stdout_read = NULL;
        if (stderr_read == INVALID_HANDLE_VALUE) stderr_read = NULL;
        goto cleanup;
    }
    job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) {
        append_windows_error(&result->stderr_buffer, "create PowerShell Job Object", GetLastError());
        goto cleanup;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        append_windows_error(&result->stderr_buffer, "configure PowerShell Job Object", GetLastError());
        goto cleanup;
    }
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(executable, command_line, NULL, NULL, FALSE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            environment, system_directory, &startup, &process)) {
        DWORD suspended_error = GetLastError();
        if (suspended_error != ERROR_ACCESS_DENIED || !CreateProcessW(executable, command_line, NULL, NULL, FALSE,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment, system_directory, &startup, &process)) {
            DWORD unsuspended_error = GetLastError();
            append_windows_error(&result->stderr_buffer, "start Windows PowerShell", suspended_error);
            if (suspended_error == ERROR_ACCESS_DENIED) {
                append_windows_error(&result->stderr_buffer, "start Windows PowerShell without suspension", unsuspended_error);
                wchar_t probe_line[256];
                wcscpy(probe_line, L"powershell.exe -NoLogo -NoProfile -NonInteractive -Command exit");
                STARTUPINFOW probe_startup = {0};
                PROCESS_INFORMATION probe_process = {0};
                probe_startup.cb = sizeof(probe_startup);
                if (CreateProcessW(executable, probe_line, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                        NULL, NULL, &probe_startup, &probe_process)) {
                    buffer_append(&result->stderr_buffer, "minimal PowerShell launch succeeded", 35);
                    WaitForSingleObject(probe_process.hProcess, 5000);
                    CloseHandle(probe_process.hThread);
                    CloseHandle(probe_process.hProcess);
                } else {
                    append_windows_error(&result->stderr_buffer, "minimal PowerShell launch", GetLastError());
                }
                wcscpy(probe_line, L"powershell.exe -NoLogo -NoProfile -NonInteractive -Command exit");
                ZeroMemory(&probe_process, sizeof(probe_process));
                if (CreateProcessW(executable, probe_line, NULL, NULL, FALSE,
                        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                        environment, system_directory, &probe_startup, &probe_process)) {
                    buffer_append(&result->stderr_buffer, "; sanitized-environment launch succeeded", 40);
                    WaitForSingleObject(probe_process.hProcess, 5000);
                    CloseHandle(probe_process.hThread);
                    CloseHandle(probe_process.hProcess);
                } else {
                    append_windows_error(&result->stderr_buffer, "sanitized-environment PowerShell launch", GetLastError());
                }
            }
            goto cleanup;
        }
        process_suspended = false;
    }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
        append_windows_error(&result->stderr_buffer, "assign PowerShell Job Object", GetLastError());
        TerminateProcess(process.hProcess, 126);
        goto cleanup;
    }
    if (process_suspended && ResumeThread(process.hThread) == (DWORD)-1) {
        append_windows_error(&result->stderr_buffer, "resume Windows PowerShell", GetLastError());
        TerminateJobObject(job, 126);
        goto cleanup;
    }
    if ((!ConnectNamedPipe(stdin_write, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) ||
        (!ConnectNamedPipe(stdout_read, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) ||
        (!ConnectNamedPipe(stderr_read, NULL) && GetLastError() != ERROR_PIPE_CONNECTED)) {
        append_windows_error(&result->stderr_buffer, "connect PowerShell named pipes", GetLastError());
        TerminateJobObject(job, 126);
        goto cleanup;
    }
    struct reader_context stdout_context = {stdout_read, &result->stdout_buffer};
    struct reader_context stderr_context = {stderr_read, &result->stderr_buffer};
    stdout_thread = CreateThread(NULL, 0, reader_thread, &stdout_context, 0, NULL);
    if (stdout_thread != NULL) stdout_read = NULL;
    stderr_thread = CreateThread(NULL, 0, reader_thread, &stderr_context, 0, NULL);
    if (stderr_thread != NULL) stderr_read = NULL;
    if (stdout_thread == NULL || stderr_thread == NULL) {
        append_windows_error(&result->stderr_buffer, "start output reader", GetLastError());
        TerminateJobObject(job, 126);
        goto cleanup;
    }
    DWORD command_length = (DWORD)strlen(command);
    DWORD written = 0;
    size_t offset = 0;
    while (offset < command_length) {
        if (!WriteFile(stdin_write, command + offset, command_length - (DWORD)offset, &written, NULL)) break;
        offset += written;
    }
    WriteFile(stdin_write, "\r\n", 2, &written, NULL);
    CloseHandle(stdin_write); stdin_write = NULL;
    DWORD wait_result = WaitForSingleObject(process.hProcess, (DWORD)timeout_seconds * 1000U);
    if (wait_result == WAIT_TIMEOUT) {
        result->timed_out = true;
        TerminateJobObject(job, 124);
        WaitForSingleObject(process.hProcess, 5000);
        result->exit_code = 124;
    } else if (wait_result == WAIT_OBJECT_0) {
        DWORD exit_code = 1;
        GetExitCodeProcess(process.hProcess, &exit_code);
        result->exit_code = exit_code <= INT_MAX ? (int)exit_code : 1;
        TerminateJobObject(job, exit_code);
    } else {
        append_windows_error(&result->stderr_buffer, "wait for Windows PowerShell", GetLastError());
        TerminateJobObject(job, 125);
    }
    status = 0;

cleanup:
    if (stdin_write != NULL) CloseHandle(stdin_write);
    if (stdout_thread != NULL) WaitForSingleObject(stdout_thread, INFINITE);
    if (stderr_thread != NULL) WaitForSingleObject(stderr_thread, INFINITE);
    if (stdout_read != NULL) CloseHandle(stdout_read);
    if (stderr_read != NULL) CloseHandle(stderr_read);
    if (stdout_thread != NULL) CloseHandle(stdout_thread);
    if (stderr_thread != NULL) CloseHandle(stderr_thread);
    if (process.hThread != NULL) CloseHandle(process.hThread);
    if (process.hProcess != NULL) CloseHandle(process.hProcess);
    if (job != NULL) CloseHandle(job);
    if (pipe_descriptor != NULL) LocalFree(pipe_descriptor);
    if (environment != NULL) {
        SecureZeroMemory(environment, environment_chars * sizeof(wchar_t));
        free(environment);
    }
    return status;
}

static bool valid_job_id(const char *job_id) {
    if (job_id == NULL || strlen(job_id) != 32) return false;
    for (size_t index = 0; index < 32; index++) if (hex_value(job_id[index]) < 0) return false;
    return true;
}

static bool job_path(wchar_t *path, size_t capacity, const char *job_id, const wchar_t *name) {
    if (!valid_job_id(job_id)) return false;
    wchar_t wide_id[33];
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, job_id, -1, wide_id, 33) == 0) return false;
    int written = name == NULL
        ? _snwprintf(path, capacity, L"%ls\\%ls", DEFAULT_JOB_ROOT, wide_id)
        : _snwprintf(path, capacity, L"%ls\\%ls\\%ls", DEFAULT_JOB_ROOT, wide_id, name);
    return written > 0 && (size_t)written < capacity;
}

static bool restricted_security(SECURITY_ATTRIBUTES *attributes, PSECURITY_DESCRIPTOR *descriptor) {
    ZeroMemory(attributes, sizeof(*attributes));
    attributes->nLength = sizeof(*attributes);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;;GA;;;SY)(A;;GA;;;BA)", SDDL_REVISION_1, descriptor, NULL)) return false;
    attributes->lpSecurityDescriptor = *descriptor;
    return true;
}

static bool write_file_atomic(const wchar_t *path, const void *data, size_t length) {
    wchar_t temporary[MAX_PATH * 3];
    if (_snwprintf(temporary, sizeof(temporary) / sizeof(temporary[0]), L"%ls.tmp.%lu", path,
            (unsigned long)GetCurrentProcessId()) <= 0) return false;
    SECURITY_ATTRIBUTES security;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!restricted_security(&security, &descriptor)) return false;
    HANDLE file = CreateFileW(temporary, GENERIC_WRITE, 0, &security, CREATE_ALWAYS,
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, NULL);
    LocalFree(descriptor);
    if (file == INVALID_HANDLE_VALUE) return false;
    const unsigned char *bytes = (const unsigned char *)data;
    size_t offset = 0;
    bool success = true;
    while (offset < length) {
        DWORD chunk = length - offset > MAXDWORD ? MAXDWORD : (DWORD)(length - offset);
        DWORD written = 0;
        if (!WriteFile(file, bytes + offset, chunk, &written, NULL) || written == 0) { success = false; break; }
        offset += written;
    }
    if (success) success = FlushFileBuffers(file) != FALSE;
    CloseHandle(file);
    if (success) success = MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    if (!success) DeleteFileW(temporary);
    return success;
}

static bool read_file_bounded(const wchar_t *path, size_t maximum, unsigned char **data, size_t *length) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size;
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || (uint64_t)size.QuadPart > maximum) { CloseHandle(file); return false; }
    unsigned char *buffer = (unsigned char *)malloc((size_t)size.QuadPart + 1);
    if (buffer == NULL) { CloseHandle(file); return false; }
    size_t offset = 0;
    while (offset < (size_t)size.QuadPart) {
        DWORD read = 0;
        if (!ReadFile(file, buffer + offset, (DWORD)((size_t)size.QuadPart - offset), &read, NULL) || read == 0) {
            free(buffer); CloseHandle(file); return false;
        }
        offset += read;
    }
    CloseHandle(file);
    buffer[offset] = 0;
    *data = buffer;
    *length = offset;
    return true;
}

static uint64_t filetime_value(FILETIME value) {
    ULARGE_INTEGER integer;
    integer.LowPart = value.dwLowDateTime;
    integer.HighPart = value.dwHighDateTime;
    return integer.QuadPart;
}

static bool process_matches_identity(const struct job_identity *identity, HANDLE *process) {
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, identity->pid);
    if (handle == NULL) return false;
    FILETIME creation, exit, kernel, user;
    bool matches = GetProcessTimes(handle, &creation, &exit, &kernel, &user) &&
        filetime_value(creation) == identity->creation_time;
    if (!matches) { CloseHandle(handle); return false; }
    *process = handle;
    return true;
}

static bool load_job_identity(const char *job_id, struct job_identity *identity) {
    wchar_t path[MAX_PATH * 3];
    unsigned char *data = NULL;
    size_t length = 0;
    if (!job_path(path, sizeof(path) / sizeof(path[0]), job_id, L"identity") ||
        !read_file_bounded(path, sizeof(*identity), &data, &length) || length != sizeof(*identity)) {
        free(data); return false;
    }
    memcpy(identity, data, sizeof(*identity));
    SecureZeroMemory(data, length); free(data);
    return true;
}

static bool persist_job_result(const char *job_id, const struct command_result *result) {
    size_t total = sizeof(struct job_result_header) + result->stdout_buffer.length + result->stderr_buffer.length;
    if (total > sizeof(struct job_result_header) + MAX_OUTPUT_BYTES * 2) return false;
    unsigned char *data = (unsigned char *)malloc(total);
    if (data == NULL) return false;
    struct job_result_header header = {
        JOB_RESULT_MAGIC, result->exit_code,
        (result->timed_out ? 1U : 0U) | (result->stdout_buffer.truncated ? 2U : 0U) |
            (result->stderr_buffer.truncated ? 4U : 0U),
        (uint32_t)result->stdout_buffer.length, (uint32_t)result->stderr_buffer.length
    };
    memcpy(data, &header, sizeof(header));
    if (header.stdout_length) memcpy(data + sizeof(header), result->stdout_buffer.data, header.stdout_length);
    if (header.stderr_length) memcpy(data + sizeof(header) + header.stdout_length,
        result->stderr_buffer.data, header.stderr_length);
    wchar_t path[MAX_PATH * 3];
    bool success = job_path(path, sizeof(path) / sizeof(path[0]), job_id, L"result") &&
        write_file_atomic(path, data, total);
    SecureZeroMemory(data, total); free(data);
    return success;
}

static bool load_job_result(const char *job_id, struct command_result *result) {
    wchar_t path[MAX_PATH * 3];
    unsigned char *data = NULL;
    size_t length = 0;
    if (!job_path(path, sizeof(path) / sizeof(path[0]), job_id, L"result") ||
        !read_file_bounded(path, sizeof(struct job_result_header) + MAX_OUTPUT_BYTES * 2, &data, &length) ||
        length < sizeof(struct job_result_header)) { free(data); return false; }
    struct job_result_header header;
    memcpy(&header, data, sizeof(header));
    if (header.magic != JOB_RESULT_MAGIC || header.stdout_length > MAX_OUTPUT_BYTES ||
        header.stderr_length > MAX_OUTPUT_BYTES ||
        length != sizeof(header) + header.stdout_length + header.stderr_length) { free(data); return false; }
    result->exit_code = header.exit_code;
    result->timed_out = (header.flags & 1U) != 0;
    result->stdout_buffer.truncated = (header.flags & 2U) != 0;
    result->stderr_buffer.truncated = (header.flags & 4U) != 0;
    if (header.stdout_length) buffer_append(&result->stdout_buffer,
        (char *)data + sizeof(header), header.stdout_length);
    if (header.stderr_length) buffer_append(&result->stderr_buffer,
        (char *)data + sizeof(header) + header.stdout_length, header.stderr_length);
    SecureZeroMemory(data, length); free(data);
    return true;
}

static bool job_marker(const char *job_id, const wchar_t *name) {
    wchar_t path[MAX_PATH * 3];
    return job_path(path, sizeof(path) / sizeof(path[0]), job_id, name) &&
        GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static bool create_job_id(char job_id[33]) {
    unsigned char random[16];
    if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
    for (size_t index = 0; index < sizeof(random); index++) sprintf(job_id + index * 2, "%02x", random[index]);
    job_id[32] = 0;
    return true;
}

static bool inspect_job_storage(int *active, int *retained, uint64_t *bytes) {
    wchar_t pattern[MAX_PATH * 3];
    _snwprintf(pattern, sizeof(pattern) / sizeof(pattern[0]), L"%ls\\*", DEFAULT_JOB_ROOT);
    WIN32_FIND_DATAW found;
    HANDLE search = FindFirstFileW(pattern, &found);
    if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
    do {
        if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || found.cFileName[0] == L'.') continue;
        char id[33];
        if (WideCharToMultiByte(CP_UTF8, 0, found.cFileName, -1, id, sizeof(id), NULL, NULL) == 0 || !valid_job_id(id)) continue;
        (*retained)++;
        if (!job_marker(id, L"result") && !job_marker(id, L"cancelled")) (*active)++;
        wchar_t files[MAX_PATH * 3];
        _snwprintf(files, sizeof(files) / sizeof(files[0]), L"%ls\\%ls\\*", DEFAULT_JOB_ROOT, found.cFileName);
        WIN32_FIND_DATAW file_data;
        HANDLE file_search = FindFirstFileW(files, &file_data);
        if (file_search != INVALID_HANDLE_VALUE) {
            do {
                if ((file_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
                *bytes += ((uint64_t)file_data.nFileSizeHigh << 32U) | file_data.nFileSizeLow;
            } while (FindNextFileW(file_search, &file_data));
            FindClose(file_search);
        }
    } while (FindNextFileW(search, &found));
    FindClose(search);
    return true;
}

static bool parse_job_start_request(const char *request, int *timeout_seconds, char **command) {
    const char *prefix = "timeoutSeconds=";
    const char *separator = strstr(request, "\ncommand=");
    if (strncmp(request, prefix, strlen(prefix)) != 0 || separator == NULL) return false;
    char timeout_text[16];
    size_t timeout_length = (size_t)(separator - request - strlen(prefix));
    if (timeout_length == 0 || timeout_length >= sizeof(timeout_text)) return false;
    memcpy(timeout_text, request + strlen(prefix), timeout_length); timeout_text[timeout_length] = 0;
    char *end = NULL;
    long timeout = strtol(timeout_text, &end, 10);
    if (*end || timeout < 1 || timeout > MAX_JOB_TIMEOUT_SECONDS) return false;
    unsigned char *decoded = NULL;
    size_t decoded_length = 0;
    if (decode_base64url(separator + strlen("\ncommand="), &decoded, &decoded_length) != 0 ||
        decoded_length == 0 || decoded_length > MAX_COMMAND_BYTES || memchr(decoded, 0, decoded_length) != NULL) {
        free(decoded); return false;
    }
    decoded[decoded_length] = 0;
    *timeout_seconds = (int)timeout;
    *command = (char *)decoded;
    return true;
}

static void respond_job_state(const char *transaction, const char *job_id, const char *state,
                              const struct command_result *result) {
    respond_begin(transaction, 200);
    printf("{\"status\":\"%s\",\"state\":\"%s\",\"jobId\":\"%s\",\"exitCode\":%d,"
        "\"signal\":0,\"timedOut\":%s,\"outputEncoding\":\"base64\",\"stdout\":",
        strcmp(state, "running") == 0 || strcmp(state, "cancelling") == 0 ? "accepted" : "completed",
        state, job_id, result == NULL ? 0 : result->exit_code,
        result != NULL && result->timed_out ? "true" : "false");
    json_base64(result == NULL || result->stdout_buffer.data == NULL ? "" : result->stdout_buffer.data,
        result == NULL ? 0 : result->stdout_buffer.length);
    fputs(",\"stderr\":", stdout);
    json_base64(result == NULL || result->stderr_buffer.data == NULL ? "" : result->stderr_buffer.data,
        result == NULL ? 0 : result->stderr_buffer.length);
    printf(",\"stdoutTruncated\":%s,\"stderrTruncated\":%s}",
        result != NULL && result->stdout_buffer.truncated ? "true" : "false",
        result != NULL && result->stderr_buffer.truncated ? "true" : "false");
    respond_end();
}

static bool remove_job_directory(const char *job_id) {
    const wchar_t *files[] = {L"command", L"identity", L"result", L"cancelled", L"worker.exe"};
    wchar_t path[MAX_PATH * 3];
    for (size_t index = 0; index < sizeof(files) / sizeof(files[0]); index++) {
        if (job_path(path, sizeof(path) / sizeof(path[0]), job_id, files[index])) DeleteFileW(path);
    }
    return job_path(path, sizeof(path) / sizeof(path[0]), job_id, NULL) && RemoveDirectoryW(path);
}

static void handle_job_start(const char *transaction, const char *request) {
    int timeout = 0;
    char *command = NULL;
    if (!parse_job_start_request(request, &timeout, &command)) { respond_error(transaction, 400, "invalid job start request"); return; }
    SECURITY_ATTRIBUTES security;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!restricted_security(&security, &descriptor)) { free(command); respond_error(transaction, 500, "job ACL creation failed"); return; }
    if (!CreateDirectoryW(DEFAULT_JOB_ROOT, &security) && GetLastError() != ERROR_ALREADY_EXISTS) {
        LocalFree(descriptor); free(command); respond_error(transaction, 500, "job storage creation failed"); return;
    }
    if (!SetFileSecurityW(DEFAULT_JOB_ROOT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor)) {
        LocalFree(descriptor); free(command); respond_error(transaction, 500, "job storage ACL failed"); return;
    }
    int active = 0, retained = 0;
    uint64_t storage_bytes = 0;
    if (!inspect_job_storage(&active, &retained, &storage_bytes)) {
        LocalFree(descriptor); free(command); respond_error(transaction, 500, "job storage inspection failed"); return;
    }
    if (active >= MAX_CONCURRENT_JOBS || retained >= MAX_RETAINED_JOBS || storage_bytes >= MAX_JOB_STORAGE_BYTES) {
        LocalFree(descriptor); free(command); respond_error(transaction, 429, "job storage limit reached; clean terminal jobs"); return;
    }
    char job_id[33] = {0};
    wchar_t directory[MAX_PATH * 3];
    bool created = false;
    for (int attempt = 0; attempt < 8 && !created; attempt++) {
        if (!create_job_id(job_id) || !job_path(directory, sizeof(directory) / sizeof(directory[0]), job_id, NULL)) break;
        created = CreateDirectoryW(directory, &security) != FALSE;
    }
    LocalFree(descriptor);
    if (!created) { SecureZeroMemory(command, strlen(command)); free(command); respond_error(transaction, 500, "job allocation failed"); return; }
    wchar_t command_path[MAX_PATH * 3], worker_path[MAX_PATH * 3], current_path[MAX_PATH * 3];
    if (!job_path(command_path, sizeof(command_path) / sizeof(command_path[0]), job_id, L"command") ||
        !job_path(worker_path, sizeof(worker_path) / sizeof(worker_path[0]), job_id, L"worker.exe") ||
        GetModuleFileNameW(NULL, current_path, sizeof(current_path) / sizeof(current_path[0])) == 0 ||
        !write_file_atomic(command_path, command, strlen(command)) || !CopyFileW(current_path, worker_path, FALSE)) {
        SecureZeroMemory(command, strlen(command)); free(command); remove_job_directory(job_id);
        respond_error(transaction, 500, "job persistence failed"); return;
    }
    SecureZeroMemory(command, strlen(command)); free(command);
    wchar_t command_line[MAX_PATH * 3 + 128];
    _snwprintf(command_line, sizeof(command_line) / sizeof(command_line[0]), L"\"%ls\" --job-worker %S %d", worker_path, job_id, timeout);
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION process = {0}; startup.cb = sizeof(startup);
    if (!CreateProcessW(worker_path, command_line, NULL, NULL, FALSE,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, NULL, directory, &startup, &process)) {
        remove_job_directory(job_id); respond_error(transaction, 500, "job worker launch failed"); return;
    }
    FILETIME creation, exit, kernel, user;
    struct job_identity identity = {process.dwProcessId, 0};
    if (!GetProcessTimes(process.hProcess, &creation, &exit, &kernel, &user)) {
        TerminateProcess(process.hProcess, 125); CloseHandle(process.hThread); CloseHandle(process.hProcess);
        remove_job_directory(job_id); respond_error(transaction, 500, "job worker identity failed"); return;
    }
    identity.creation_time = filetime_value(creation);
    wchar_t identity_path[MAX_PATH * 3];
    bool identity_written = job_path(identity_path, sizeof(identity_path) / sizeof(identity_path[0]), job_id, L"identity") &&
        write_file_atomic(identity_path, &identity, sizeof(identity));
    if (!identity_written) {
        TerminateProcess(process.hProcess, 125); WaitForSingleObject(process.hProcess, 5000);
        CloseHandle(process.hThread); CloseHandle(process.hProcess); remove_job_directory(job_id);
        respond_error(transaction, 500, "job worker identity persistence failed"); return;
    }
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    respond_job_state(transaction, job_id, "running", NULL);
}

static void handle_job_status(const char *transaction, const char *job_id) {
    if (!valid_job_id(job_id)) { respond_error(transaction, 400, "invalid job id"); return; }
    struct command_result result = {0};
    if (load_job_result(job_id, &result)) {
        const char *state = result.timed_out ? "timed_out" : result.exit_code == 0 ? "succeeded" : "failed";
        respond_job_state(transaction, job_id, state, &result);
        free(result.stdout_buffer.data); free(result.stderr_buffer.data); return;
    }
    if (job_marker(job_id, L"cancelled")) { respond_job_state(transaction, job_id, "cancelled", NULL); return; }
    struct job_identity identity; HANDLE process = NULL;
    if (!load_job_identity(job_id, &identity)) { respond_error(transaction, 404, "job not found"); return; }
    if (!process_matches_identity(&identity, &process) || WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
        if (process != NULL) CloseHandle(process);
        result.exit_code = 125;
        buffer_append(&result.stderr_buffer, "job worker exited without a result", 34);
        persist_job_result(job_id, &result);
        respond_job_state(transaction, job_id, "failed", &result);
        free(result.stderr_buffer.data); return;
    }
    CloseHandle(process);
    respond_job_state(transaction, job_id, "running", NULL);
}

static void handle_job_cancel(const char *transaction, const char *job_id) {
    if (!valid_job_id(job_id)) { respond_error(transaction, 400, "invalid job id"); return; }
    struct command_result result = {0};
    if (load_job_result(job_id, &result)) { free(result.stdout_buffer.data); free(result.stderr_buffer.data); respond_job_state(transaction, job_id, "completed", NULL); return; }
    struct job_identity identity; HANDLE process = NULL;
    if (!load_job_identity(job_id, &identity)) { respond_error(transaction, 404, "job not found"); return; }
    if (process_matches_identity(&identity, &process)) { TerminateProcess(process, 130); WaitForSingleObject(process, 5000); CloseHandle(process); }
    wchar_t path[MAX_PATH * 3];
    if (!job_path(path, sizeof(path) / sizeof(path[0]), job_id, L"cancelled") || !write_file_atomic(path, "cancelled", 9)) {
        respond_error(transaction, 500, "could not persist cancellation"); return;
    }
    respond_job_state(transaction, job_id, "cancelled", NULL);
}

static void handle_job_cleanup(const char *transaction, const char *job_id) {
    if (!valid_job_id(job_id)) { respond_error(transaction, 400, "invalid job id"); return; }
    struct command_result result = {0};
    bool terminal = load_job_result(job_id, &result) || job_marker(job_id, L"cancelled");
    free(result.stdout_buffer.data); free(result.stderr_buffer.data);
    if (!terminal) { respond_error(transaction, 409, "job is still running"); return; }
    struct job_identity identity; HANDLE process = NULL;
    if (load_job_identity(job_id, &identity) && process_matches_identity(&identity, &process)) {
        WaitForSingleObject(process, 5000); CloseHandle(process);
    }
    if (!remove_job_directory(job_id)) { respond_error(transaction, 500, "job cleanup failed"); return; }
    respond_job_state(transaction, job_id, "cleaned", NULL);
}

static int job_worker_main(const char *job_id, int timeout_seconds) {
    wchar_t command_path[MAX_PATH * 3], cancel_path[MAX_PATH * 3];
    unsigned char *command = NULL; size_t command_length = 0;
    if (!valid_job_id(job_id) || timeout_seconds < 1 || timeout_seconds > MAX_JOB_TIMEOUT_SECONDS ||
        !job_path(command_path, sizeof(command_path) / sizeof(command_path[0]), job_id, L"command") ||
        !read_file_bounded(command_path, MAX_COMMAND_BYTES, &command, &command_length) || command_length == 0) return 125;
    DeleteFileW(command_path);
    struct command_result result = {0};
    int status = run_command((char *)command, timeout_seconds, &result);
    SecureZeroMemory(command, command_length); free(command);
    bool cancelled = job_path(cancel_path, sizeof(cancel_path) / sizeof(cancel_path[0]), job_id, L"cancelled") &&
        GetFileAttributesW(cancel_path) != INVALID_FILE_ATTRIBUTES;
    if (!cancelled) {
        if (status != 0) result.exit_code = 125;
        persist_job_result(job_id, &result);
    }
    free(result.stdout_buffer.data); free(result.stderr_buffer.data);
    return status == 0 ? 0 : 125;
}

static int cancel_all_jobs(void) {
    wchar_t pattern[MAX_PATH * 3];
    _snwprintf(pattern, sizeof(pattern) / sizeof(pattern[0]), L"%ls\\*", DEFAULT_JOB_ROOT);
    WIN32_FIND_DATAW found; HANDLE search = FindFirstFileW(pattern, &found);
    if (search == INVALID_HANDLE_VALUE) return 0;
    do {
        if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || found.cFileName[0] == L'.') continue;
        char id[33]; struct job_identity identity; HANDLE process = NULL;
        if (WideCharToMultiByte(CP_UTF8, 0, found.cFileName, -1, id, sizeof(id), NULL, NULL) == 0 ||
            !valid_job_id(id) || !load_job_identity(id, &identity)) continue;
        if (process_matches_identity(&identity, &process)) { TerminateProcess(process, 130); WaitForSingleObject(process, 5000); CloseHandle(process); }
        wchar_t marker[MAX_PATH * 3];
        if (job_path(marker, sizeof(marker) / sizeof(marker[0]), id, L"cancelled")) write_file_atomic(marker, "cancelled", 9);
    } while (FindNextFileW(search, &found));
    FindClose(search);
    return 0;
}

static char *read_protocol_line(void) {
    size_t capacity = 256;
    size_t length = 0;
    char *line = (char *)malloc(capacity);
    if (line == NULL) return NULL;
    int value;
    while ((value = fgetc(stdin)) != EOF) {
        if (length + 2 > capacity) {
            capacity *= 2;
            char *next = (char *)realloc(line, capacity);
            if (next == NULL) {
                free(line);
                return NULL;
            }
            line = next;
        }
        line[length++] = (char)value;
        if (value == '\n') break;
    }
    if (length == 0 && value == EOF) {
        free(line);
        return NULL;
    }
    line[length] = '\0';
    return line;
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
    if (!command_function && !job_start_function && !job_status_function && !job_cancel_function && !job_cleanup_function) {
        respond_error(transaction, 404, "unknown function");
        return;
    }
    char *command = NULL;
    char error[256] = {0};
    if (!verify_request(body, &command, error, sizeof(error))) {
        respond_error(transaction, 403, error);
        return;
    }
    if (job_start_function) handle_job_start(transaction, command);
    else if (job_status_function) handle_job_status(transaction, command);
    else if (job_cancel_function) handle_job_cancel(transaction, command);
    else if (job_cleanup_function) handle_job_cleanup(transaction, command);
    if (job_start_function || job_status_function || job_cancel_function || job_cleanup_function) {
        SecureZeroMemory(command, strlen(command)); free(command); return;
    }
    if (timeout_seconds < 1) timeout_seconds = 1;
    if (timeout_seconds > 300) timeout_seconds = 300;
    struct command_result result = {0};
    if (run_command(command, timeout_seconds, &result) != 0) {
        SecureZeroMemory(command, strlen(command));
        free(command);
        respond_error(transaction, 500,
            result.stderr_buffer.data != NULL && result.stderr_buffer.length > 0
                ? result.stderr_buffer.data
                : "failed to start Windows PowerShell");
        free(result.stdout_buffer.data);
        free(result.stderr_buffer.data);
        return;
    }
    SecureZeroMemory(command, strlen(command));
    free(command);
    respond_command(transaction, &result);
    free(result.stdout_buffer.data);
    free(result.stderr_buffer.data);
}

static void process_payload_header(const char *header) {
    struct buffer body = {0};
    char *line;
    while ((line = read_protocol_line()) != NULL) {
        if (strcmp(line, "FUNCTION_PAYLOAD_END\n") == 0 || strcmp(line, "FUNCTION_PAYLOAD_END\r\n") == 0) {
            free(line);
            break;
        }
        size_t length = strlen(line);
        if (body.length + length > MAX_REQUEST_BYTES) body.truncated = true;
        else buffer_append(&body, line, length);
        free(line);
    }
    if (body.data == NULL) {
        body.data = (char *)calloc(1, 1);
        body.capacity = 1;
    }
    if (body.truncated) {
        char transaction[65] = {0};
        sscanf(header, "%*s %64s", transaction);
        respond_error(transaction, 413, "request payload is too large");
    } else handle_payload(header, body.data);
    free(body.data);
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
    size_t encoded_length = 0;
    char *encoded = encode_base64((const unsigned char *)value, length, &encoded_length);
    if (encoded == NULL) {
        fputs("\"\"", stdout);
        return;
    }
    json_string(encoded, encoded_length);
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
    printf("{\"status\":%d,\"error\":", status);
    json_string(message, strlen(message));
    putchar('}');
    respond_end();
}

static void windows_identity(char sid[192], bool *is_system, DWORD *integrity_rid) {
    strcpy(sid, "unknown");
    *is_system = false;
    *integrity_rid = 0;
    HANDLE token = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return;
    DWORD length = 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &length);
    TOKEN_USER *user = (TOKEN_USER *)malloc(length);
    if (user != NULL && GetTokenInformation(token, TokenUser, user, length, &length)) {
        LPSTR converted = NULL;
        if (ConvertSidToStringSidA(user->User.Sid, &converted)) {
            snprintf(sid, 192, "%s", converted);
            LocalFree(converted);
        }
        BYTE system_sid[SECURITY_MAX_SID_SIZE];
        DWORD system_length = sizeof(system_sid);
        if (CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_length)) {
            *is_system = EqualSid(user->User.Sid, system_sid) != FALSE;
        }
    }
    free(user);
    length = 0;
    GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &length);
    TOKEN_MANDATORY_LABEL *label = (TOKEN_MANDATORY_LABEL *)malloc(length);
    if (label != NULL && GetTokenInformation(token, TokenIntegrityLevel, label, length, &length)) {
        UCHAR count = *GetSidSubAuthorityCount(label->Label.Sid);
        if (count > 0) *integrity_rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
    }
    free(label);
    CloseHandle(token);
}

static const char *integrity_name(DWORD rid) {
    if (rid >= SECURITY_MANDATORY_SYSTEM_RID) return "system";
    if (rid >= SECURITY_MANDATORY_HIGH_RID) return "high";
    if (rid >= SECURITY_MANDATORY_MEDIUM_RID) return "medium";
    if (rid >= SECURITY_MANDATORY_LOW_RID) return "low";
    return "unknown";
}

static void respond_health(const char *transaction) {
    char sid[192];
    bool is_system;
    DWORD integrity_rid;
    BOOL process_in_job = FALSE;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits = {0};
    bool job_information_available = false;
    HANDLE process_token = NULL;
    bool token_restricted = false;
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY child_process_policy = {0};
    bool child_process_policy_available = false;
    windows_identity(sid, &is_system, &integrity_rid);
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &process_token)) {
        token_restricted = IsTokenRestricted(process_token) != FALSE;
        CloseHandle(process_token);
    }
    child_process_policy_available = GetProcessMitigationPolicy(GetCurrentProcess(), ProcessChildProcessPolicy,
        &child_process_policy, sizeof(child_process_policy)) != FALSE;
    if (IsProcessInJob(GetCurrentProcess(), NULL, &process_in_job) && process_in_job) {
        job_information_available = QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation,
            &job_limits, sizeof(job_limits), NULL) != FALSE;
    }
    respond_begin(transaction, 200);
    printf("{\"status\":\"ok\",\"plugin\":\"webminai\",\"version\":\"%s\","
        "\"platform\":\"windows\",\"executionMode\":\"windows-system\",\"identitySid\":",
        WEBMINAI_PLUGIN_VERSION);
    json_string(sid, strlen(sid));
    printf(",\"isLocalSystem\":%s,\"durableJobs\":true,\"maxConcurrentJobs\":%d,\"integrityLevel\":\"%s\",\"integrityRid\":%lu,"
        "\"tokenRestricted\":%s,\"childProcessPolicyAvailable\":%s,\"childProcessPolicyFlags\":%lu,"
        "\"processInJob\":%s,\"jobInformationAvailable\":%s,\"jobLimitFlags\":%lu,\"activeProcessLimit\":%lu}",
        is_system ? "true" : "false", MAX_CONCURRENT_JOBS, integrity_name(integrity_rid), (unsigned long)integrity_rid,
        token_restricted ? "true" : "false", child_process_policy_available ? "true" : "false",
        child_process_policy_available ? (unsigned long)child_process_policy.Flags : 0UL,
        process_in_job ? "true" : "false", job_information_available ? "true" : "false",
        job_information_available ? (unsigned long)job_limits.BasicLimitInformation.LimitFlags : 0UL,
        job_information_available ? (unsigned long)job_limits.BasicLimitInformation.ActiveProcessLimit : 0UL);
    respond_end();
}

static void respond_command(const char *transaction, const struct command_result *result) {
    respond_begin(transaction, 200);
    printf("{\"status\":\"completed\",\"exitCode\":%d,\"signal\":0,\"timedOut\":%s,"
        "\"outputEncoding\":\"base64\",\"stdout\":",
        result->exit_code, result->timed_out ? "true" : "false");
    json_base64(result->stdout_buffer.data == NULL ? "" : result->stdout_buffer.data, result->stdout_buffer.length);
    fputs(",\"stderr\":", stdout);
    json_base64(result->stderr_buffer.data == NULL ? "" : result->stderr_buffer.data, result->stderr_buffer.length);
    printf(",\"stdoutTruncated\":%s,\"stderrTruncated\":%s}",
        result->stdout_buffer.truncated ? "true" : "false",
        result->stderr_buffer.truncated ? "true" : "false");
    respond_end();
}

static int plugin_loop(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    printf("CHART webminai.status '' 'WebminAI Stage 2 status' 'state' webminai webminai.status line 90000 1\n");
    printf("DIMENSION active 'active' absolute 1 1\n");
    printf("BEGIN webminai.status\nSET active = 1\nEND\n");
    printf("FUNCTION GLOBAL \"webminai:health\" 10 \"WebminAI plugin health\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:command\" 300 \"Run a signed, approved PowerShell task as LocalSystem\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_start\" 15 \"Start a signed durable LocalSystem command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_status\" 15 \"Read a signed durable command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_cancel\" 15 \"Cancel a signed durable command job\" \"\" \"any\" 100 1\n");
    printf("FUNCTION GLOBAL \"webminai:job_cleanup\" 15 \"Remove a terminal durable command job\" \"\" \"any\" 100 1\n");
    fflush(stdout);
    char *line;
    while ((line = read_protocol_line()) != NULL) {
        if (strcmp(line, "QUIT\n") == 0 || strcmp(line, "QUIT\r\n") == 0) {
            free(line);
            break;
        }
        if (strncmp(line, "FUNCTION_PAYLOAD ", 17) == 0 || strncmp(line, "FUNCTION_PAYLOAD_BEGIN ", 23) == 0) {
            process_payload_header(line);
        } else if (strncmp(line, "FUNCTION ", 9) == 0) {
            char transaction[65] = {0};
            if (sscanf(line, "FUNCTION %64s", transaction) == 1) {
                if (strstr(line, "webminai:health") != NULL) respond_health(transaction);
                else if (strstr(line, "webminai:") != NULL) {
                    respond_error(transaction, 400, "signed WebminAI functions require a JSON payload");
                }
            }
        }
        free(line);
    }
    return 0;
}

int main(int argc, char **argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts(WEBMINAI_PLUGIN_VERSION);
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--platform") == 0) {
        puts("windows");
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "--job-worker") == 0) {
        char *end = NULL;
        long timeout = strtol(argv[3], &end, 10);
        if (*end || timeout < 1 || timeout > MAX_JOB_TIMEOUT_SECONDS) return 125;
        return job_worker_main(argv[2], (int)timeout);
    }
    if (argc == 2 && strcmp(argv[1], "--cancel-all-jobs") == 0) return cancel_all_jobs();
    return plugin_loop();
}
