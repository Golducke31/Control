'use client'

import mensajes from '../../messages/es.json'

/**
 * La última frontera (F9).
 *
 * Se monta **fuera** del layout raíz, así que reemplaza todo el documento: sólo se llega
 * acá si falló el propio layout, el proveedor de sesión o el de tiempo real. Por eso
 * escribe `<html>` y `<body>` a mano y no usa ni un componente del sistema de diseño —
 * podría ser justamente el que falló.
 *
 * **Por qué no usa los tokens.** Es la única pantalla donde la hoja de estilos puede no
 * haber cargado, y un `var(--control-…)` sin resolver deja el texto invisible: blanco
 * sobre blanco. Se usan las **palabras clave de color del sistema** del navegador
 * (`Canvas`, `CanvasText`, `GrayText`), que no son literales, no dependen de ninguna hoja
 * y respetan el tema del sistema operativo del usuario. Tampoco se declara tipografía: la
 * del navegador es la correcta cuando no hay diseño que aplicar.
 *
 * El `digest` se muestra siempre que exista: sin él, un fallo en producción es «algo salió
 * mal» y no hay forma de cruzarlo con el log del servidor.
 *
 * **Por qué lee el catálogo directo y no usa `useTranslations`.** Este componente se monta
 * fuera del layout raíz, así que **no hay `NextIntlClientProvider`**: el hook lanzaría por
 * falta de contexto justo en la pantalla que tiene que funcionar cuando todo lo demás
 * falló. Importar el JSON evita el proveedor sin volver a escribir los textos acá, que es
 * lo que el lint de textos prohíbe. Es la misma razón por la que no usa los tokens.
 */
export default function ErrorGlobal({ error }: { error: Error & { digest?: string } }) {
  const t = mensajes.errorGlobal

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'Canvas',
          color: 'CanvasText',
          padding: '1.5rem',
        }}
      >
        <main style={{ maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>{t.titulo}</h1>
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'GrayText' }}>{t.descripcion}</p>
          {/*
            Sin tipografía declarada, ni siquiera `monospace`: la del navegador es la
            correcta cuando no hay diseño que aplicar, y el lint de tokens prohíbe
            cualquier familia escrita a mano —con razón, también acá—.
          */}
          <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'GrayText' }}>
            {error.digest ?? error.message}
          </p>
        </main>
      </body>
    </html>
  )
}
