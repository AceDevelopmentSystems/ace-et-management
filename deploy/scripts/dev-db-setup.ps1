<#
.SYNOPSIS
  One-time local setup: creates a dev login role and database on an existing PostgreSQL install
  and writes a gitignored .env with DATABASE_URL and JWT_SECRET.

.DESCRIPTION
  The 'postgres' superuser password is read from the POSTGRES_ADMIN_PASSWORD environment variable if set;
  otherwise psql prompts for it (up to four times). It is never stored by the script.
  The new role's password is generated randomly and written only to the .env file.
  The role gets CREATEROLE because the migrations create the restricted runtime role ace_app, and
  CREATEDB so the test suite can create a throwaway database per run.

.EXAMPLE
  pwsh deploy/scripts/dev-db-setup.ps1                              # PostgreSQL 16 on 5432
  pwsh deploy/scripts/dev-db-setup.ps1 -Port 5433 -PgBin "C:\Program Files\PostgreSQL\18\bin"
#>
param(
  [int]$Port = 5432,
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [string]$Db = "ace_dev",
  [string]$Role = "ace_dev",
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\..\apps\api\.env")
)
$ErrorActionPreference = "Stop"
$psql = Join-Path $PgBin "psql.exe"

function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
  ([Convert]::ToHexString($b)).ToLower()
}

# Run psql as postgres; native commands do not honour $ErrorActionPreference, so check the exit code.
function Invoke-Pg([string[]]$PsqlArgs) {
  # -w: never prompt when the password comes from the environment, so a wrong password fails instead of hanging.
  [string[]]$noPrompt = if ($env:POSTGRES_ADMIN_PASSWORD) { @("-w") } else { @() }
  $out = & $psql @noPrompt -h localhost -p $Port -U postgres -v ON_ERROR_STOP=1 @PsqlArgs
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE). Nothing was written to $EnvFile." }
  $out
}

# Use POSTGRES_ADMIN_PASSWORD when set (no prompts); otherwise psql prompts. Scoped to this script only.
$prevPgPassword = $env:PGPASSWORD
if ($env:POSTGRES_ADMIN_PASSWORD) { $env:PGPASSWORD = $env:POSTGRES_ADMIN_PASSWORD }
try {

$pw = New-Secret 16
$jwt = New-Secret 32

$roleExists = Invoke-Pg @("-tAc", "SELECT 1 FROM pg_roles WHERE rolname = '$Role'")
$verb = if ($roleExists) { "ALTER" } else { "CREATE" }
Invoke-Pg @("-c", "$verb ROLE $Role LOGIN CREATEROLE CREATEDB PASSWORD '$pw'") | Out-Null

$dbExists = Invoke-Pg @("-tAc", "SELECT 1 FROM pg_database WHERE datname = '$Db'")
if (-not $dbExists) { Invoke-Pg @("-c", "CREATE DATABASE $Db OWNER $Role") | Out-Null }

# Prove the new credentials work before writing them anywhere.
$url = "postgres://${Role}:${pw}@localhost:${Port}/${Db}"
$who = & $psql -w -tAc "SELECT current_user" $url 2>&1   # options must precede the URL on Windows
if ($LASTEXITCODE -ne 0 -or "$who".Trim() -ne $Role) { throw "Created the role but could not log in as it: $who" }

@"
DATABASE_URL=$url
JWT_SECRET=$jwt
PORT=3000
"@ | Set-Content -Path $EnvFile -Encoding ascii
Write-Host "OK: role '$Role' and database '$Db' on port $Port verified. Wrote $EnvFile (gitignored)."

} finally {
  $env:PGPASSWORD = $prevPgPassword
}
