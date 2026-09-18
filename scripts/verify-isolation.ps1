<#
================================================================================
 Control · Verificación de aislamiento multi-tenant en Windows
--------------------------------------------------------------------------------
 QUÉ HACE

   Corre, de punta a punta y en este orden, lo que el plan de verificación pide:

     1. Comprueba que psql exista (PostgreSQL 16).
     2. Crea la base `control`.
     3. Aplica las 11 migraciones en orden, y aborta en el primer error.
     4. Aplica el catálogo del sistema (seed).
     5. Crea el rol de aplicación `app_login` (miembro de control_app).
     6. Corre el lint de cobertura RLS.
     7. Corre la suite de aislamiento con el rol de aplicación.
     8. Corre la PRUEBA NEGATIVA: con el DSN de superusuario la suite debe abortar.

 POR QUÉ ESTE SCRIPT Y NO UN COMANDO SUELTO

   El comando original era sintaxis de bash (`for f in $(ls ...)`) ejecutada en
   PowerShell, que no la entiende. Acá va la versión nativa: `Get-ChildItem |
   Sort-Object | ForEach-Object`.

   El orden importa y no es el obvio: `app_login` se crea DESPUÉS de migrar,
   porque el rol `control_app` del que depende lo crea la migración 0007.

 POR QUÉ DOS ROLES

   El superusuario de PostgreSQL ignora RLS siempre, incluso con FORCE ROW LEVEL
   SECURITY. Con un solo rol privilegiado, la suite daría "OK" con las políticas
   rotas. Por eso: `postgres` sólo migra y prepara; `app_login` es el que prueba.

 USO

   Abrí PowerShell **como Administrador** y ejecutá:

     powershell -ExecutionPolicy Bypass -File scripts/verify-isolation.ps1

   Si PostgreSQL está en otra ruta:

     powershell -ExecutionPolicy Bypass -File scripts/verify-isolation.ps1 `
       -PgBin "C:\Program Files\PostgreSQL\16\bin"

 Las contraseñas de abajo son de PRUEBA LOCAL. No usarlas nunca fuera de esto.
================================================================================
#>

[CmdletBinding()]
param(
  [string]$PgBin    = 'C:\Program Files\PostgreSQL\16\bin',
  [string]$DbName   = 'control',
  [string]$PgHost   = 'localhost',
  [int]   $PgPort   = 5432,
  [string]$PgUser   = 'postgres',
  [string]$PgPass   = 'P0stgres!',
  [string]$AppUser  = 'app_login',
  [string]$AppPass  = 'AppL0gin!'
)

$ErrorActionPreference = 'Stop'

# -----------------------------------------------------------------------------
# Utilidades de salida. Con color para que un vistazo alcance para saber dónde
# se rompió: en una corrida de 11 migraciones, un volcado monocromo no sirve.
# -----------------------------------------------------------------------------
function Write-Step($n, $text) {
  Write-Host "`n$('=' * 72)" -ForegroundColor DarkGray
  Write-Host " $n · $text" -ForegroundColor Cyan
  Write-Host ('=' * 72) -ForegroundColor DarkGray
}
function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [AVISO] $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  [FALLA] $text" -ForegroundColor Red }

$script:Failures = @()

# Raíz del repo: el script vive en scripts/, así que sube un nivel.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$Psql     = Join-Path $PgBin 'psql.exe'
$Createdb = Join-Path $PgBin 'createdb.exe'

$AdminDsn = "postgres://${PgUser}:${PgPass}@${PgHost}:${PgPort}/${DbName}"
$AppDsn   = "postgres://${AppUser}:${AppPass}@${PgHost}:${PgPort}/${DbName}"

# psql lee PGPASSWORD del entorno; sin esto pediría la clave de forma interactiva
# y el script se colgaría esperando input que nunca llega.
$env:PGPASSWORD = $PgPass

# -----------------------------------------------------------------------------
# 1 · Herramientas
# -----------------------------------------------------------------------------
Write-Step 1 'Verificar PostgreSQL 16'

if (-not (Test-Path $Psql)) {
  Write-Fail "No se encontró psql en: $Psql"
  Write-Host @"

  PostgreSQL 16 no está instalado en la ruta esperada.

  Instalalo con Chocolatey, en una consola ELEVADA:

      choco install postgresql16 --params '/Password:P0stgres!' -y

  Si ya lo tenés en otra ruta, pasala por parámetro:

      ... -PgBin "C:\ruta\a\PostgreSQL\16\bin"
"@ -ForegroundColor Yellow
  exit 2
}

$psqlVersion = (& $Psql --version) -join ''
Write-Ok $psqlVersion

if ($psqlVersion -notmatch '1[6-9]\.') {
  Write-Warn2 "Se esperaba PostgreSQL 16 o superior. Las vistas usan security_invoker (PG 15+) y las particiones requieren 16."
}

Write-Host '  · Verificando extensiones requeridas por 0001 (pgcrypto, citext, btree_gin)...'
# Se consultan sobre la base de mantenimiento para no depender de que `control` exista.
$extOut = (& $Psql "postgres://${PgUser}:${PgPass}@${PgHost}:${PgPort}/postgres" -t -A -c `
  "SELECT name FROM pg_available_extensions WHERE name IN ('pgcrypto','citext','btree_gin') ORDER BY name;" 2>&1) -join "`n"
foreach ($ext in @('btree_gin', 'citext', 'pgcrypto')) {
  if ($extOut -match [regex]::Escape($ext)) { Write-Ok "extensión disponible: $ext" }
  else {
    Write-Fail "extensión NO disponible: $ext"
    Write-Host '      Instalá postgresql16-contrib: choco install postgresql16 --params ''/Password:P0stgres!/IncludeContrib''' -ForegroundColor Yellow
    $script:Failures += "Falta la extensión $ext"
  }
}

# -----------------------------------------------------------------------------
# 2 · Base de datos
# -----------------------------------------------------------------------------
Write-Step 2 "Crear la base `"$DbName`" (si no existe)"

$exists = (& $Psql "postgres://${PgUser}:${PgPass}@${PgHost}:${PgPort}/postgres" -t -A -c `
  "SELECT 1 FROM pg_database WHERE datname = '$DbName';") -join ''
$exists = $exists.Trim()

if ($exists -eq '1') {
  Write-Warn2 "La base `"$DbName`" ya existe. Se reutiliza."
  Write-Host '         Ojo: si las migraciones ya corrieron acá, van a fallar por objetos' -ForegroundColor DarkGray
  Write-Host '         existentes. Para empezar limpio, dropeala antes:' -ForegroundColor DarkGray
  Write-Host "           dropdb -U $PgUser -h $PgHost $DbName" -ForegroundColor DarkGray
} else {
  & $Createdb -U $PgUser -h $PgHost -p $PgPort $DbName
  if ($LASTEXITCODE -ne 0) { Write-Fail "createdb falló (exit $LASTEXITCODE)"; exit 2 }
  Write-Ok "Base `"$DbName`" creada."
}

# -----------------------------------------------------------------------------
# 3 · Migraciones
# -----------------------------------------------------------------------------
Write-Step 3 'Aplicar migraciones en orden'

$migrations = Get-ChildItem -Path (Join-Path $RepoRoot 'db\migrations') -Filter '*.sql' |
              Sort-Object Name

if ($migrations.Count -eq 0) { Write-Fail 'No se encontraron migraciones.'; exit 2 }
Write-Host "  $($migrations.Count) archivos.`n" -ForegroundColor DarkGray

$failed = $null
foreach ($mig in $migrations) {
  Write-Host "  ▶ $($mig.Name)" -ForegroundColor White -NoNewline

  # -v ON_ERROR_STOP=1 es obligatorio: sin él, psql sigue tras un error y las
  # migraciones quedan a medias SIN avisar. Es el peor modo de falla posible:
  # creerias que migraste.
  $out = (& $Psql $AdminDsn -v ON_ERROR_STOP=1 -q -f $mig.FullName 2>&1) -join "`n"

  if ($LASTEXITCODE -ne 0) {
    Write-Host '  ✗' -ForegroundColor Red
    Write-Host $out -ForegroundColor Red
    $failed = $mig.Name
    break
  }
  Write-Host '  ✓' -ForegroundColor Green
}

if ($failed) {
  Write-Host @"

  Falló: $failed

  Cómo leer el error:
    · Nombra un objeto del proyecto (tabla, política, extensión)
        → es un defecto DE ESQUEMA. Corregí la migración.
    · Es de conexión, PATH o permisos
        → es del ENTORNO. Corregí la invocación, no el SQL.

  NO desactives ON_ERROR_STOP para "seguir de largo": dejaría el esquema a
  medias y las pruebas posteriores medirían otra cosa.
"@ -ForegroundColor Yellow
  exit 1
}
Write-Ok "$($migrations.Count) migraciones aplicadas."

# -----------------------------------------------------------------------------
# 4 · Seed
# -----------------------------------------------------------------------------
Write-Step 4 'Aplicar catálogo del sistema'

& $Psql $AdminDsn -v ON_ERROR_STOP=1 -q -f (Join-Path $RepoRoot 'db\seed\0001_system_catalog.sql')
if ($LASTEXITCODE -ne 0) { Write-Fail 'El seed falló.'; exit 1 }
Write-Ok 'Catálogo del sistema aplicado.'

# La aserción de cobertura es la barrera F0-AC2. Si falla acá, no tiene sentido
# seguir: la suite mediría un esquema que ya se declaró inconsistente.
Write-Host '  · Verificando app.assert_rls_coverage()...'
$assertOut = (& $Psql $AdminDsn -v ON_ERROR_STOP=1 -c 'SELECT app.assert_rls_coverage();' 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) {
  Write-Fail 'app.assert_rls_coverage() falló: hay tablas con tenant_id sin cobertura RLS.'
  Write-Host $assertOut -ForegroundColor Red
  exit 1
}
Write-Ok 'Cobertura RLS verificada por la aserción.'

# -----------------------------------------------------------------------------
# 5 · Rol de aplicación
# -----------------------------------------------------------------------------
Write-Step 5 'Crear el rol de aplicación'

# Se crea DESPUÉS de migrar: depende de control_app, que nace en la 0007.
$roleExists = (& $Psql $AdminDsn -t -A -c `
  "SELECT 1 FROM pg_roles WHERE rolname = '$AppUser';") -join ''
if ($roleExists.Trim() -eq '1') {
  Write-Warn2 "El rol `"$AppUser`" ya existe. Se recrea para garantizar sus propiedades."
  & $Psql $AdminDsn -v ON_ERROR_STOP=1 -q -c "DROP OWNED BY $AppUser;" 2>&1 | Out-Null
  & $Psql $AdminDsn -v ON_ERROR_STOP=1 -q -c "DROP ROLE IF EXISTS $AppUser;" 2>&1 | Out-Null
}

# NOBYPASSRLS es la propiedad que hace que la suite mida algo. Sin ella, este
# rol ignoraría las políticas igual que un superusuario y el resultado sería un
# falso OK. Se declara explícitamente en vez de confiar en el default.
& $Psql $AdminDsn -v ON_ERROR_STOP=1 -c `
  "CREATE ROLE $AppUser LOGIN PASSWORD '$AppPass' NOBYPASSRLS IN ROLE control_app;"
if ($LASTEXITCODE -ne 0) { Write-Fail "No se pudo crear $AppUser."; exit 1 }
Write-Ok "Rol `"$AppUser`" creado (miembro de control_app, sin BYPASSRLS)."

# Confirmación de las propiedades, leídas del catálogo y no asumidas.
$props = (& $Psql $AdminDsn -t -A -c `
  "SELECT rolsuper || '|' || rolbypassrls || '|' || pg_has_role('$AppUser','control_app','MEMBER')
   FROM pg_roles WHERE rolname = '$AppUser';") -join ''
$props = $props.Trim()

if ($props -ne 'f|f|t') {
  Write-Fail "Propiedades inesperadas para $AppUser`: $props (se esperaba f|f|t)"
  Write-Host '      f|f|t = no superusuario, sin bypassrls, miembro de control_app.' -ForegroundColor Yellow
  exit 1
}
Write-Ok 'Propiedades confirmadas: f|f|t (no superusuario, sin bypass, miembro de control_app).'

# -----------------------------------------------------------------------------
# 6 · Lint de cobertura RLS
# -----------------------------------------------------------------------------
Write-Step 6 'Lint de cobertura RLS (contra el esquema final)'

$lintFile = Join-Path $RepoRoot 'tests\isolation\lint_rls_coverage.sql'
$lintOut  = (& $Psql $AppDsn -t -A -f $lintFile 2>&1) -join "`n"
$lintRows = ($lintOut -split "`n" | Where-Object {
  $_.Trim() -ne '' -and $_ -notmatch '^Recordatorio'
})

if ($lintRows.Count -gt 0) {
  Write-Fail "El lint detectó $($lintRows.Count) problema(s) de cobertura:"
  $lintRows | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
  $script:Failures += 'Lint de cobertura RLS'
} else {
  Write-Ok 'Sin defectos de cobertura.'
}

# -----------------------------------------------------------------------------
# 7 · Suite de aislamiento
# -----------------------------------------------------------------------------
Write-Step 7 'Suite de aislamiento (rol de aplicación)'

$env:DATABASE_URL       = $AppDsn
$env:ADMIN_DATABASE_URL = $AdminDsn

& node tests/isolation/run.mjs --verbose
$suiteRc = $LASTEXITCODE

if ($suiteRc -eq 0) { Write-Ok 'Suite en verde: el aislamiento se sostiene.' }
elseif ($suiteRc -eq 2) {
  Write-Fail 'La suite abortó (exit 2): problema de entorno o de rol, no una fuga.'
  Write-Host '      Leé el mensaje de arriba: distingue rol privilegiado de base ausente.' -ForegroundColor Yellow
  $script:Failures += 'Suite abortada por entorno (exit 2)'
} else {
  Write-Fail "La suite detectó fugas (exit $suiteRc)."
  $script:Failures += 'Fugas de aislamiento detectadas'
}

# -----------------------------------------------------------------------------
# 8 · Prueba negativa
#
# Sin esto, la corrección del Defecto A no está probada: si la guardia de rol
# estuviera rota, la suite pasaría en verde con un rol privilegiado y nadie se
# enteraría. Acá se exige que ABORTE.
# -----------------------------------------------------------------------------
Write-Step 8 'Prueba negativa: la suite debe ABORTAR con rol privilegiado'

Write-Host '  Corriendo la suite con el DSN de superusuario...' -ForegroundColor DarkGray
& node tests/isolation/run.mjs --dsn $AdminDsn --admin-dsn $AdminDsn 2>&1 | Out-Null
$negRc = $LASTEXITCODE

if ($negRc -eq 2) {
  Write-Ok 'La guardia funcionó: abortó (exit 2) con rol privilegiado.'
} else {
  Write-Fail "La suite NO abortó con el DSN de superusuario (exit $negRc)."
  Write-Host @"
      Esto significa que la guardia de rol está rota y que, con un rol
      privilegiado, la suite daría un falso OK. Es el defecto que esta prueba
      existe para atrapar: revisá assertAppRole() en tests/isolation/run.mjs.
"@ -ForegroundColor Yellow
  $script:Failures += 'La guardia de rol no aborta (Defecto A sin corregir)'
}

# -----------------------------------------------------------------------------
# Resumen
# -----------------------------------------------------------------------------
Write-Host "`n$('=' * 72)" -ForegroundColor DarkGray
if ($script:Failures.Count -eq 0) {
  Write-Host ' RESULTADO: VERIFICACIÓN COMPLETA · todo en verde' -ForegroundColor Green
  Write-Host ('=' * 72) -ForegroundColor DarkGray
  Write-Host @"

  Qué quedó probado:
    · Las 11 migraciones son reproducibles desde cero.
    · app.assert_rls_coverage() pasa sobre el esquema final.
    · Ninguna tabla con tenant_id quedó sin FORCE RLS ni sin política.
    · Ninguna partición quedó sin cobertura propia (el defecto de 0008).
    · Autenticado como empresa A, no se ve ni se escribe nada de B.
    · Sin contexto de sesión, todo devuelve 0 filas (fail-closed).
    · La guardia aborta si el rol es privilegiado.

  Siguiente paso: lo que la corrida haya destapado. Si algo falló arriba,
  el mensaje indica si es de esquema o de entorno.
"@ -ForegroundColor Gray
  exit 0
} else {
  Write-Host " RESULTADO: $($script:Failures.Count) problema(s)" -ForegroundColor Red
  Write-Host ('=' * 72) -ForegroundColor DarkGray
  $script:Failures | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
  exit 1
}
