'use client'

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
 */
export default function ErrorGlobal({ error }: { error: Error & { digest?: string } }) {
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
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>La aplicación no pudo iniciarse</h1>
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'GrayText' }}>
            Es un fallo del armazón, no de una ventana. Recargá la página; si vuelve a pasar, pasale esta referencia
            al soporte.
          </p>
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
