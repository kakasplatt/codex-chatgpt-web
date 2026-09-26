$env:RUNNER_TEMP = $env:TEMP

$buildEnv = Join-Path $env:TEMP "codex-web-gpt-build.env"
Remove-Item $buildEnv -Force -ErrorAction SilentlyContinue

.\scripts\prepare-windows-baseline-bun.ps1 `
    -Version 1.4.0 `
    -GitHubEnv $buildEnv

$line = Get-Content $buildEnv |
    Where-Object { $_ -like 'CODEX_CHATGPT_WEB_EMBEDDED_BUN=*' } |
    Select-Object -Last 1

$bun = ($line -split '=', 2)[1]

$env:CODEX_CHATGPT_WEB_EMBEDDED_BUN = $bun
$env:CODEX_WEB_GPT_BUN = $bun
$env:Path = "$(Split-Path $bun);$env:Path"

bun --version
