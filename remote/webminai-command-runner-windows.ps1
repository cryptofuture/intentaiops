param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^webminai-[0-9]+-[0-9]+-in$')]
    [string]$InputPipe,

    [Parameter(Mandatory = $true, Position = 1)]
    [ValidatePattern('^webminai-[0-9]+-[0-9]+-out$')]
    [string]$OutputPipe,

    [Parameter(Mandatory = $true, Position = 2)]
    [ValidatePattern('^webminai-[0-9]+-[0-9]+-err$')]
    [string]$ErrorPipe
)

$inputStream = [IO.Pipes.NamedPipeClientStream]::new('.', $InputPipe, [IO.Pipes.PipeDirection]::In)
$outputStream = [IO.Pipes.NamedPipeClientStream]::new('.', $OutputPipe, [IO.Pipes.PipeDirection]::Out)
$errorStream = [IO.Pipes.NamedPipeClientStream]::new('.', $ErrorPipe, [IO.Pipes.PipeDirection]::Out)
$reader = $null
$writer = $null
$errorWriter = $null

try {
    $inputStream.Connect(10000)
    $outputStream.Connect(10000)
    $errorStream.Connect(10000)
    $utf8 = [Text.UTF8Encoding]::new($false)
    $reader = [IO.StreamReader]::new($inputStream, $utf8)
    $writer = [IO.StreamWriter]::new($outputStream, $utf8)
    $errorWriter = [IO.StreamWriter]::new($errorStream, $utf8)
    $writer.AutoFlush = $true
    $errorWriter.AutoFlush = $true
    $ErrorActionPreference = 'Stop'
    try {
        $source = $reader.ReadToEnd()
        . ([ScriptBlock]::Create($source)) 2>&1 | ForEach-Object {
            $rendered = ($_ | Out-String).TrimEnd()
            if ($_ -is [Management.Automation.ErrorRecord]) {
                $errorWriter.WriteLine($rendered)
            } else {
                $writer.WriteLine($rendered)
            }
        }
        if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } catch {
        $errorWriter.WriteLine(($_ | Out-String))
        exit 1
    }
} finally {
    if ($writer) { $writer.Dispose() }
    if ($errorWriter) { $errorWriter.Dispose() }
    if ($reader) { $reader.Dispose() }
    $inputStream.Dispose()
    $outputStream.Dispose()
    $errorStream.Dispose()
}
