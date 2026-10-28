<#
.SYNOPSIS
Launch a command with the DPAPI-protected Meta API key in ITS environment only (MEM-009).

.DESCRIPTION
Usage: run_live.ps1 [-KeyFile <path>] [command args...]
Default key file: $HOME/.secrets/meta-api-key.dpapi
Default command:  uv run uvicorn memripal.app:app --host 127.0.0.1 --port 8000
Loopback only until the S7 passcode gate lands: never bind a public interface.
The key is set only on the child's ProcessStartInfo (META_API_KEY, MEMRIPAL_MODE=meta); it is
never written to a file, stdout, the parent environment or a transcript. Exit code = child's.
MEMRIPAL_CHAT_PROVIDER=baseten|fireworks (MEM-026) also decrypts $HOME/.secrets/<provider>-api-key.dpapi
into the child's BASETEN_API_KEY / FIREWORKS_API_KEY the same way; META_API_KEY is still loaded
(SAM stays on Meta). Unset, meta and local load no extra key. A missing key file exits 2.
#>

# Arguments are parsed by hand instead of a param() block: PowerShell would positionally bind
# the first child token to -KeyFile, and prefix-match child flags such as `-c` to parameters.
$KeyFile = Join-Path $HOME '.secrets/meta-api-key.dpapi'
$Command = @($args)
if ($Command.Count -ge 2 -and $Command[0] -eq '-KeyFile') {
    $KeyFile = $Command[1]
    $Command = @($Command | Select-Object -Skip 2)
}
if ($Command.Count -eq 0) {
    $Command = @('uv', 'run', 'uvicorn', 'memripal.app:app', '--host', '127.0.0.1', '--port', '8000')
}

$ErrorActionPreference = 'Stop'

# cmd.exe re-parses batch-file arguments (metacharacters, %VAR% expansion), defeating the quoting below.
if ([System.IO.Path]::GetExtension($Command[0]) -in @('.cmd', '.bat')) {
    [Console]::Error.WriteLine("run_live: refusing .cmd/.bat child '$($Command[0])'; launch an .exe directly")
    exit 2
}

if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
    [Console]::Error.WriteLine("run_live: key file not found: $KeyFile")
    exit 2
}

# Case-sensitive like the backend's own check: only these two providers carry a key.
$Provider = $env:MEMRIPAL_CHAT_PROVIDER
$ProviderKeyFile = $null
if ($Provider -cin @('baseten', 'fireworks')) {
    $ProviderKeyFile = Join-Path $HOME ".secrets/$Provider-api-key.dpapi"
    if (-not (Test-Path -LiteralPath $ProviderKeyFile -PathType Leaf)) {
        [Console]::Error.WriteLine("run_live: $Provider key file not found: $ProviderKeyFile")
        exit 2
    }
}

# Load by path from this host's own $PSHOME: a PowerShell 7 PSModulePath inherited by Windows
# PowerShell 5.1 otherwise breaks ConvertTo-SecureString autoload.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')

function ConvertTo-WindowsArgument([string]$Value) {
    # CommandLineToArgvW quoting; needed because .NET Framework's ProcessStartInfo has no ArgumentList.
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $out = '"'
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' }
        else { $out += ('\' * $slashes) + $ch }
        $slashes = 0
    }
    return $out + ('\' * ($slashes * 2)) + '"'
}

$encrypted = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
$secure = ConvertTo-SecureString -String $encrypted

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Command[0]
$psi.Arguments = (@($Command | Select-Object -Skip 1) | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['META_API_KEY'] = (New-Object System.Net.NetworkCredential('', $secure)).Password
$psi.EnvironmentVariables['MEMRIPAL_MODE'] = 'meta'
if ($ProviderKeyFile) {
    $providerSecure = ConvertTo-SecureString -String (Get-Content -LiteralPath $ProviderKeyFile -Raw).Trim()
    $plain = (New-Object System.Net.NetworkCredential('', $providerSecure)).Password
    $psi.EnvironmentVariables[$Provider.ToUpper() + '_API_KEY'] = $plain
    $providerSecure.Dispose()
    Remove-Variable providerSecure, plain
}

$child = [System.Diagnostics.Process]::Start($psi)
$psi = $null
$secure.Dispose()
Remove-Variable secure, encrypted
$child.WaitForExit()
exit $child.ExitCode
