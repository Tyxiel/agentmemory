<#
.SYNOPSIS
  Detecta e aplica divergencia entre o plugin no repositorio e o instalado.

.DESCRIPTION
  O arquivo em ~/.config/opencode/plugins/ e um ARTEFATO DE INSTALACAO.
  Nunca o edite direto: edite no repositorio e rode este script. Sem essa
  disciplina o instalado fica pre-correcao enquanto o PR avanca, que e
  exatamente o que aconteceu em 2026-10-02.

  O script apenas AVISA por padrao. Sync automatico esconderia uma regressao
  vinda do PR, entao aplicar exige --apply explicito.

.EXAMPLE
  .\sync-opencode-plugin.ps1
  Compara e reporta. Nao altera nada.

.EXAMPLE
  .\sync-opencode-plugin.ps1 -Apply
  Copia o do repositorio para o instalado e revalida o hash.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Repo = "$PSScriptRoot\..",
  [string]$Installed = "$HOME\.config\opencode\plugins\agentmemory-capture.ts"
)

$ErrorActionPreference = "Stop"

$source = Join-Path $Repo "plugin\opencode\agentmemory-capture.ts"

function Get-Hash([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return (Get-FileHash $Path -Algorithm SHA256).Hash
}

$srcHash = Get-Hash $source
$dstHash = Get-Hash $Installed

if (-not $srcHash) {
  Write-Error "Fonte nao encontrada: $source"
  exit 1
}

Write-Host "origem:     $source"
Write-Host "            $($srcHash.Substring(0, 12))  ($((Get-Item $source).Length) bytes)"
Write-Host "instalado:  $Installed"
if ($dstHash) {
  Write-Host "            $($dstHash.Substring(0, 12))  ($((Get-Item $Installed).Length) bytes)"
} else {
  Write-Host "            AUSENTE"
}

if ($srcHash -eq $dstHash) {
  Write-Host ""
  Write-Host "EM SINCronia." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "DIVERGENTE: o instalado NAO corresponde ao repositorio." -ForegroundColor Yellow

# O blocker do V2: ler event.properties em vez de event.data.
if ($dstHash) {
  $readsProperties = Select-String -Path $Installed -Pattern '\(event as any\)\.properties' -Quiet
  if ($readsProperties) {
    Write-Host "  O instalado ainda le event.properties, o blocker do V2. Captura morta." -ForegroundColor Red
  }
  $lines = ([System.IO.File]::ReadAllLines($Installed)).Length
  $srcLines = ([System.IO.File]::ReadAllLines($source)).Length
  Write-Host "  linhas: instalado $lines vs repositorio $srcLines"
}

if (-not $Apply) {
  Write-Host ""
  Write-Host "Nada foi alterado. Rode com -Apply para sincronizar." -ForegroundColor Cyan
  exit 1
}

$backup = "$Installed.pre-sync.bak"
Copy-Item $Installed $backup -Force
Write-Host ""
Write-Host "backup do anterior: $backup"

Copy-Item $source $Installed -Force

$new = Get-Hash $Installed
if ($new -eq $srcHash) {
  Write-Host "copiado e conferido por hash. Em sincronia." -ForegroundColor Green
  Write-Host ""
  Write-Host "Reinicie para validar: opencode service restart" -ForegroundColor Cyan
  exit 0
}

Write-Error "hash divergente apos a copia: $new != $srcHash"
exit 1