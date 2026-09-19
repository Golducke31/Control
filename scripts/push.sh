#!/usr/bin/env bash
# Push a GitHub en este entorno.
#
# POR QUÉ EXISTE ESTE ARCHIVO
# ---------------------------
# `git push` a secas falla acá con:
#     fatal: could not read Username for 'https://github.com': terminal prompts disabled
#
# La causa NO es que falten credenciales. La credencial está guardada en el
# Administrador de credenciales de Windows y `git-credential-wincred` la
# devuelve sin problema. Lo que pasa es que el helper configurado en este
# entorno no llega a activarse durante el push, y el sandbox no puede abrir
# un prompt de terminal. Resultado: Git se queda sin usuario y aborta.
#
# La solución es sacar la credencial del almacén nosotros mismos y pasarla en
# un header HTTP efímero, sólo para este comando. Así:
#   - el token nunca toca el disco ni el historial,
#   - nunca se imprime en pantalla,
#   - no queda configurado en el repo.
#
# USO
#   bash scripts/push.sh            # empuja la rama actual a origin
#   bash scripts/push.sh origin main
#
# Emanuel: si algún día el token caduca, el error pasa a ser 403 en vez de
# "could not read Username". En ese caso hay que renovar el PAT en GitHub y
# volver a guardarlo:
#     git credential approve   (protocol=https, host=github.com)

set -u

GIT_CRED_HELPER="C:/Users/emanu/.workbuddy-ai/binaries/PortableGit/versions/1.2.0/mingw64/bin/git-credential-wincred.exe"
REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

if [ ! -x "$GIT_CRED_HELPER" ]; then
  echo "✗ No encuentro el helper de credenciales en $GIT_CRED_HELPER" >&2
  echo "  Ajustá la ruta al binario de git-credential-wincred.exe de tu instalación." >&2
  exit 1
fi

# La consulta va con `protocol`/`host` y una línea vacía final: ese es el
# formato que espera el protocolo de git-credential. Sin la línea vacía el
# helper se queda esperando y devuelve nada.
CREDENCIAL=$(printf 'protocol=https\nhost=github.com\n\n' | "$GIT_CRED_HELPER" get 2>/dev/null)

USUARIO=$(printf '%s' "$CREDENCIAL" | sed -n 's/^username=//p')
TOKEN=$(printf '%s' "$CREDENCIAL" | sed -n 's/^password=//p')

if [ -z "$TOKEN" ]; then
  echo "✗ El almacén de credenciales no tiene un token para github.com." >&2
  echo "  Guardalo así (una sola vez):" >&2
  echo "    printf 'protocol=https\\nhost=github.com\\nusername=Golducke31\\npassword=<PAT>\\n\\n' | $GIT_CRED_HELPER store" >&2
  exit 1
fi

[ -n "$USUARIO" ] || USUARIO="Golducke31"

# Con username/password alcanza para Basic auth. El token viaja en el header
# de este único comando; `-c` lo hace local y no persiste nada en el repo.
B64=$(printf '%s:%s' "$USUARIO" "$TOKEN" | base64 -w0)

exec git -c http.extraheader="Authorization: Basic $B64" push "$REMOTE" "$BRANCH"
