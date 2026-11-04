<#
.SYNOPSIS
Push one DPAPI-protected API key to GCP Secret Manager through gcloud's stdin (MEM-111).

.DESCRIPTION
Usage: push_secret_gcp.ps1 <meta-api-key|baseten-api-key|fireworks-api-key>
Decrypts $HOME/.secrets/<name>.dpapi (the format scripts/run_live.ps1 reads), then runs
`gcloud secrets describe <name>`: exit 0 adds a version, otherwise creates the secret. The key
reaches gcloud only as stdin bytes (UTF-8, no BOM, no trailing newline): never argv, env, stdout
or a file. gcloud = $env:MEMRIPAL_GCLOUD, else gcloud.cmd on PATH. Exit code = the add/create
call's; an unknown name, a missing key file or a gcloud not on PATH exits 2 without running gcloud.
#>

$Names = @('meta-api-key', 'baseten-api-key', 'fireworks-api-key')
# Case-sensitive allowlist: the name becomes both a file path and a gcloud argument.
if ($args.Count -ne 1 -or [string]$args[0] -cnotin $Names) {
    [Console]::Error.WriteLine("push_secret_gcp: usage: push_secret_gcp.ps1 <$($Names -join '|')>")
    exit 2
}
$Name = [string]$args[0]

$ErrorActionPreference = 'Stop'

$KeyFile = Join-Path $HOME ".secrets/$Name.dpapi"
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
    [Console]::Error.WriteLine("push_secret_gcp: key file not found: $KeyFile")
    exit 2
}

$Gcloud = $env:MEMRIPAL_GCLOUD
if (-not $Gcloud) { $Gcloud = 'gcloud.cmd' }
if (-not [System.IO.Path]::IsPathRooted($Gcloud)) {
    # gcloud.cmd finds its install via %~dp0, which is the cwd when launched by bare name.
    $resolved = Get-Command $Gcloud -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolved) {
        [Console]::Error.WriteLine("push_secret_gcp: gcloud not found on PATH: $Gcloud")
        exit 2
    }
    $Gcloud = $resolved.Source
}
$ViaCmd = [System.IO.Path]::GetExtension($Gcloud) -in @('.cmd', '.bat')

# Same reason as run_live.ps1: an inherited PowerShell 7 PSModulePath breaks the autoload.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')

function ConvertTo-ChildArgument([string]$Value) {
    # cmd.exe treats ( ) & | < > ^ as syntax unless quoted; every argument here is a fixed literal
    # or an allowlisted name, so none contains a double quote needing escapes.
    if ($Value -match '[\s()&|<>^%!]') { return '"' + $Value + '"' }
    return $Value
}

function Invoke-Gcloud([string[]]$GcloudArgs, [byte[]]$StdinBytes) {
    $argLine = ($GcloudArgs | ForEach-Object { ConvertTo-ChildArgument $_ }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($ViaCmd) {
        # .NET Framework cannot start a batch file without a shell; /s strips exactly the outer quotes.
        $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $psi.Arguments = '/d /s /c ""' + $Gcloud + '" ' + $argLine + '"'
    } else {
        $psi.FileName = $Gcloud
        $psi.Arguments = $argLine
    }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $child = [System.Diagnostics.Process]::Start($psi)
    if ($StdinBytes) {
        $child.StandardInput.BaseStream.Write($StdinBytes, 0, $StdinBytes.Length)
        $child.StandardInput.BaseStream.Flush()
    }
    $child.StandardInput.Close()
    $child.WaitForExit()
    return $child.ExitCode
}

$secure = ConvertTo-SecureString -String (Get-Content -LiteralPath $KeyFile -Raw).Trim()
$plain = (New-Object System.Net.NetworkCredential('', $secure)).Password.TrimEnd("`r", "`n")
$keyBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($plain)
$secure.Dispose()
Remove-Variable secure, plain

$describeExit = Invoke-Gcloud @('secrets', 'describe', $Name, '--format=value(name)') $null
if ($describeExit -eq 0) {
    $code = Invoke-Gcloud @('secrets', 'versions', 'add', $Name, '--data-file=-') $keyBytes
} else {
    $code = Invoke-Gcloud @('secrets', 'create', $Name, '--replication-policy=automatic', '--data-file=-') $keyBytes
}
[Array]::Clear($keyBytes, 0, $keyBytes.Length)

if ($code -eq 0) {
    Write-Output "pushed $Name"
} else {
    [Console]::Error.WriteLine("push_secret_gcp: gcloud exited $code for $Name")
}
exit $code
