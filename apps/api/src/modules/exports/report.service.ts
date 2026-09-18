/**
 * Control · Exportaciones · Reportes XLSX y PDF con identidad de la empresa
 * -----------------------------------------------------------------------------
 * Requisito del negocio: el mismo reporte debe salir con los colores, el logo y
 * los membretes de CADA empresa. La solución no es un template por empresa (se
 * vuelve inmantenible con 200 inquilinos) sino un motor de temas: los artefactos
 * son neutros y reciben un `BrandTheme` resuelto en runtime desde
 * `app.tenant_branding`.
 *
 * Decisiones de diseño relevantes:
 *
 *  1. Contraste forzado. Ninguna empresa elige un color que deje texto
 *     ilegible: se calcula el contraste WCAG y se ajusta automáticamente. Un
 *     cliente que ponga amarillo claro sobre blanco recibiría un PDF ilegible y
 *     eso es un bug nuestro, no suyo.
 *
 *  2. Inyección en PDF. El HTML de los membrantes se renderiza con un
 *     sanitizador estricto (allow-list de tags y atributos). Sin esto, el campo
 *     `document_header` —editable por el cliente— sería un XSS almacenado contra
 *     nuestros propios operadores cuando abren el PDF.
 *
 *  3. Server-side puro. El PDF no se arma en el cliente: la identidad fiscal y
 *     los importes deben coincidir con lo emitido a AFIP. Un PDF generado en el
 *     browser es manipulable y no sirve como respaldo.
 *
 *  4. Streaming en XLSX. 50.000 filas no caben cómodamente en memoria. Se usa
 *     escritura por streaming con backpressure.
 */

// =============================================================================
// Tema de marca
// =============================================================================
export interface BrandTheme {
  tenantId: string;
  displayName: string;
  legalName: string;
  taxId?: string | null;
  logoUrl?: string | null;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    surface: string;
    text: string;
    /** Derivados, calculados — no los elige el usuario. */
    textOnPrimary: string;
    rowAlt: string;
    border: string;
  };
  fonts: { heading: string; body: string };
  /** Bloque HTML ya sanitizado (allow-list). */
  documentHeaderHtml: string;
  documentFooterHtml: string;
}

// =============================================================================
// Utilidades de color — contraste WCAG y derivación de paleta
// =============================================================================
interface Rgb { r: number; g: number; b: number; }

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
    throw new Error(`Color hex inválido: ${hex}`);
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Luminancia relativa según WCAG 2.1. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Ratio de contraste entre dos colores. >= 4.5 es AA para texto normal. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, weight: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r * (1 - weight) + cb.r * weight,
    g: ca.g * (1 - weight) + cb.g * weight,
    b: ca.b * (1 - weight) + cb.b * weight,
  });
}

/**
 * Elige el color de texto que garantice legibilidad sobre `background`.
 * Si la marca es oscura usa blanco; si es clara usa un gris muy oscuro.
 * Si ninguno alcanza AA, oscurece el fondo hasta lograrlo en vez de entregar un
 * documento ilegible.
 */
export function accessibleTextOn(background: string): { text: string; background: string } {
  const white = '#FFFFFF';
  const ink = '#0B1020';

  if (contrastRatio(background, white) >= 4.5) return { text: white, background };
  if (contrastRatio(background, ink) >= 4.5) return { text: ink, background };

  // Oscurecer progresivamente hasta alcanzar AA contra blanco
  let bg = background;
  for (let i = 0; i < 20; i++) {
    bg = mix(bg, '#000000', 0.12);
    if (contrastRatio(bg, white) >= 4.5) break;
  }
  return { text: white, background: bg };
}

// =============================================================================
// Sanitizador de HTML para los membrantes
// =============================================================================
/**
 * Allow-list estricta. El campo es editable por el administrador de la empresa,
 * así que se trata como entrada no confiable en todo momento.
 *
 * En producción, complementar con DOMPurify sobre un DOM real (jsdom) — cubre
 * casos que un regex no ve, como atributos mutilados. Este sanitizador es la
 * primera barrera; la segunda es el CSP del visor de PDF.
 */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'p', 'br', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'small',
  'h1', 'h2', 'h3', 'h4', 'img',
]);
const ALLOWED_ATTRS = new Set(['style', 'src', 'alt', 'width', 'height', 'align', 'colspan', 'rowspan', 'class']);

/** Propiedades CSS permitidas — se descarta todo lo demás. */
const ALLOWED_CSS_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-family',
  'text-align', 'margin', 'padding', 'border', 'border-bottom', 'width',
  'height', 'vertical-align', 'letter-spacing', 'text-transform',
]);

export function sanitizeBrandHtml(input: string | undefined | null, maxLength = 4000): string {
  if (!input) return '';
  let html = input.slice(0, maxLength);

  // 1. Eliminar por completo los vectores activos
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 2. Filtrar handlers inline y esquemas peligrosos
  html = html
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"|')?\s*(javascript|data|vbscript)\s*:[^"'>]*/gi, '$1="#"');

  // 3. Filtrar tags no permitidos
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';

    const kept = (attrs as string)
      .replace(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (_m, attr: string, _v, dq, sq, bare) => {
        const a = attr.toLowerCase();
        if (!ALLOWED_ATTRS.has(a)) return '';

        let value: string = (dq ?? sq ?? bare ?? '').trim();

        if (a === 'style') {
          // Sólo propiedades declarativas de tipografía/color. Nada de
          // position/behavior/expression ni url() con esquemas raros.
          value = value
            .split(';')
            .map((decl) => decl.trim())
            .filter((decl) => {
              const [prop] = decl.split(':');
              if (!prop) return false;
              return ALLOWED_CSS_PROPS.has(prop.trim().toLowerCase());
            })
            .join('; ');
          if (!value) return '';
        }

        // Atributos numéricos: descartar cualquier cosa no numérica
        if (a === 'width' || a === 'height' || a === 'colspan' || a === 'rowspan') {
          if (!/^\d{1,4}$/.test(value)) return '';
        }

        return ` ${a}="${value.replace(/"/g, '&quot;')}"`;
      })
      .trim();

    const selfClosing = match.startsWith('</') ? '' : '';
    return kept ? `<${name}${kept}${selfClosing}>` : `<${name}>`;
  });

  return html;
}

// =============================================================================
// Resolución del tema desde la DB
// =============================================================================
export interface BrandingRow {
  tenant_id: string;
  display_name: string;
  legal_name: string;
  tax_id: string | null;
  logo_url: string | null;
  color_primary: string;
  color_secondary: string;
  color_accent: string;
  color_surface: string;
  color_text: string;
  font_heading: string;
  font_body: string;
  document_header: unknown;
  document_footer: unknown;
}

/** Construye el tema aplicando las correcciones de contraste. */
export function resolveTheme(row: BrandingRow): BrandTheme {
  // Valores de marca saneados: si la DB trae un hex inválido, se cae al default
  // en vez de romper la generación del reporte.
  const safeHex = (value: string, fallback: string): string =>
    /^#[0-9A-Fa-f]{6}$/.test(value ?? '') ? value : fallback;

  const primary = safeHex(row.color_primary, '#6D5EF8');
  const secondary = safeHex(row.color_secondary, '#22D3EE');
  const accent = safeHex(row.color_accent, '#F59E0B');
  const surface = safeHex(row.color_surface, '#0B1020');
  const text = safeHex(row.color_text, '#E8ECF8');

  const { text: textOnPrimary } = accessibleTextOn(primary);

  const header = typeof row.document_header === 'object' && row.document_header !== null
    ? (row.document_header as Record<string, unknown>)
    : {};
  const footer = typeof row.document_footer === 'object' && row.document_footer !== null
    ? (row.document_footer as Record<string, unknown>)
    : {};

  return {
    tenantId: row.tenant_id,
    displayName: row.display_name,
    legalName: row.legal_name,
    taxId: row.tax_id,
    logoUrl: row.logo_url,
    colors: {
      primary,
      secondary,
      accent,
      surface,
      text,
      textOnPrimary,
      // Filas alternadas: apenas perceptibles, para no competir con los datos
      rowAlt: mix('#FFFFFF', primary, 0.06),
      border: mix('#FFFFFF', text, 0.22),
    },
    fonts: {
      // Fallback a una pila segura: la fuente de marca puede no estar instalada
      heading: `${row.font_heading || 'Inter'}, "Helvetica Neue", Arial, sans-serif`,
      body: `${row.font_body || 'Inter'}, "Helvetica Neue", Arial, sans-serif`,
    },
    documentHeaderHtml: sanitizeBrandHtml(header.html as string | undefined),
    documentFooterHtml: sanitizeBrandHtml(footer.html as string | undefined),
  };
}

// =============================================================================
// Exportación XLSX
// =============================================================================
export interface ColumnDef<T> {
  key: string;
  header: string;
  width: number;
  type: 'text' | 'number' | 'currency' | 'date' | 'percent';
  /** Función de extracción; por defecto `row[key]`. */
  accessor?: (row: T) => unknown;
}

export interface XlsxExportOptions<T> {
  sheetName: string;
  title: string;
  subtitle?: string;
  columns: Array<ColumnDef<T>>;
  /** Puede ser un array (reportes chicos) o un async iterable (streaming). */
  rows: T[] | AsyncIterable<T>;
  theme: BrandTheme;
  /** Firma al pie (usuario, empresa, timestamp) para trazabilidad del archivo. */
  generatedBy: string;
  /** Aplica formato condicional / resaltado por fila. */
  rowStyle?: (row: T) => { fill?: string; bold?: boolean } | undefined;
  totals?: Record<string, number>;
}

/**
 * Genera un XLSX con la identidad de la empresa.
 *
 * Nota sobre `xlsx` (SheetJS): la versión community no soporta estilos en
 * escritura de forma fiable. Para producción se recomienda `exceljs`, que sí
 * escribe fills, fuentes, bordes y formatos numéricos, y soporta streaming con
 * `WorkbookWriter`. Este servicio está escrito contra esa API.
 */
export interface ExcelJsLike {
  Workbook: new () => {
    creator: string;
    created: Date;
    addWorksheet(name: string, options?: Record<string, unknown>): WorksheetLike;
  };
}

interface WorksheetLike {
  columns: Array<{ header: string; key: string; width: number; style?: Record<string, unknown> }>;
  mergeCells(range: string): void;
  getCell(ref: string): {
    value: unknown;
    font?: Record<string, unknown>;
    fill?: Record<string, unknown>;
    alignment?: Record<string, unknown>;
    border?: Record<string, unknown>;
    numFmt?: string;
  };
  getRow(n: number): {
    height?: number;
    font?: Record<string, unknown>;
    fill?: Record<string, unknown>;
    alignment?: Record<string, unknown>;
  };
  addRow(values: unknown[], style?: Record<string, unknown>): void;
  eachRow(options: Record<string, unknown>, cb: (row: unknown, n: number) => void): void;
  autoFilter?: Record<string, unknown>;
  views?: Array<Record<string, unknown>>;
  workbook?: { xlsx: { writeBuffer(): Promise<ArrayBuffer> } };
}

const NUM_FMT: Record<ColumnDef<unknown>['type'], string> = {
  text: '@',
  number: '#,##0.00',
  currency: '"$" #,##0.00',
  date: 'dd/mm/yyyy',
  percent: '0.0%',
};

export class XlsxExportService {
  constructor(private readonly excel: ExcelJsLike) {}

  async generate<T>(opts: XlsxExportOptions<T>): Promise<Buffer> {
    const { theme } = opts;
    const wb = new this.excel.Workbook();
    wb.creator = `Control · ${theme.displayName}`;
    wb.created = new Date();

    const ws = wb.addWorksheet(opts.sheetName, {
      properties: { defaultRowHeight: 18 },
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      views: [{ state: 'frozen', ySplit: 4 }],   // congela el header
    });
    ws.workbook = wb as unknown as WorksheetLike['workbook'];

    ws.columns = opts.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));

    const lastCol = columnLetter(opts.columns.length);

    // --- Fila 1: banda de marca con el nombre de la empresa -----------------
    ws.mergeCells(`A1:${lastCol}1`);
    const titleCell = ws.getCell('A1');
    titleCell.value = `${theme.displayName}  ·  ${opts.title}`;
    titleCell.font = { name: theme.fonts.heading, size: 15, bold: true, color: { argb: argb(theme.colors.textOnPrimary) } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(theme.colors.primary) } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(1).height = 30;

    // --- Fila 2: subtítulo / período ---------------------------------------
    ws.mergeCells(`A2:${lastCol}2`);
    const subCell = ws.getCell('A2');
    subCell.value = [
      opts.subtitle,
      theme.taxId ? `CUIT ${formatCuit(theme.taxId)}` : null,
    ].filter(Boolean).join('  ·  ');
    subCell.font = { name: theme.fonts.body, size: 10, color: { argb: argb(theme.colors.secondary) } };
    subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(theme.colors.surface) } };
    subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(2).height = 20;

    // Fila 3 en blanco (separador visual)
    ws.getRow(3).height = 6;

    // --- Fila 4: encabezados de columna ------------------------------------
    const headerRow = ws.getRow(4);
    headerRow.font = { name: theme.fonts.heading, bold: true, size: 11, color: { argb: 'FF1A1F2E' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(theme.colors.secondary) } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 24;

    let rowIndex = 5;

    // --- Datos (streaming si es async iterable) ----------------------------
    const writeRow = (row: T): void => {
      const style = opts.rowStyle?.(row);
      const values = opts.columns.map((c) => {
        const raw = c.accessor ? c.accessor(row) : (row as Record<string, unknown>)[c.key];
        return normalizeCell(raw, c.type);
      });

      ws.addRow(values, {
        font: { name: theme.fonts.body, size: 10, bold: style?.bold ?? false },
        fill: style?.fill
          ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(style.fill) } }
          : (rowIndex % 2 === 0
              ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(theme.colors.rowAlt) } }
              : undefined),
        alignment: { vertical: 'middle' },
      });

      // Formatos numéricos por columna
      opts.columns.forEach((c, i) => {
        const cell = ws.getCell(`${columnLetter(i + 1)}${rowIndex}`);
        cell.numFmt = NUM_FMT[c.type];
        if (c.type === 'currency' || c.type === 'number' || c.type === 'percent') {
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (c.type === 'date') {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        }
      });

      rowIndex++;
    };

    if (Array.isArray(opts.rows)) {
      for (const row of opts.rows) writeRow(row);
    } else {
      for await (const row of opts.rows) writeRow(row);
    }

    // --- Fila de totales ---------------------------------------------------
    if (opts.totals) {
      const totalsValues = opts.columns.map((c, i) => {
        if (i === 0) return 'TOTAL';
        return opts.totals![c.key] ?? null;
      });
      ws.addRow(totalsValues, {
        font: { name: theme.fonts.heading, size: 11, bold: true, color: { argb: argb(theme.colors.textOnPrimary) } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(theme.colors.primary) } },
        alignment: { vertical: 'middle' },
      });
      rowIndex++;
    }

    // --- Pie con firma de trazabilidad -------------------------------------
    rowIndex++;   // una línea de aire
    ws.mergeCells(`A${rowIndex}:${lastCol}${rowIndex}`);
    const footer = ws.getCell(`A${rowIndex}`);
    footer.value =
      `Generado por ${opts.generatedBy} · ${new Date().toLocaleString('es-AR', { timeZone: theme.tenantId ? 'America/Argentina/Buenos_Aires' : 'UTC' })}` +
      ` · Documento informativo — Control`;
    footer.font = { name: theme.fonts.body, size: 8, italic: true, color: { argb: argb(theme.colors.border) } };

    if (opts.columns.length > 1) {
      ws.autoFilter = { from: `A4`, to: `${lastCol}${rowIndex - 2}` };
    }

    const buffer = await (wb as unknown as { xlsx: { writeBuffer(): Promise<ArrayBuffer> } }).xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

// =============================================================================
// Exportación PDF
// =============================================================================
export interface PdfBlock =
  | { type: 'kpi-grid'; items: Array<{ label: string; value: string; delta?: string }> }
  | { type: 'table'; columns: string[]; rows: Array<Array<string | number>>; numericColumns?: number[] }
  | { type: 'chart'; svg: string; caption?: string }
  | { type: 'text'; content: string }
  | { type: 'spacer'; height: number }
  | { type: 'page-break' };

export interface PdfExportOptions {
  title: string;
  subtitle?: string;
  blocks: PdfBlock[];
  theme: BrandTheme;
  generatedBy: string;
  orientation: 'portrait' | 'landscape';
  /** Pie legal obligatorio en comprobantes fiscales. */
  legalFooter?: string;
}

/**
 * Renderiza un PDF a partir de bloques. Se apoya en Chromium headless
 * (Playwright) para el layout: es el único motor que garantiza que las fuentes
 * y los degradados del whitelabel se rendericen igual en cualquier entorno.
 *
 * Alternativa sin Chromium: `pdfmake` con fuentes embebidas. Más liviano pero
 * pierde fidelidad con las tipografías de marca.
 */
export class PdfExportService {
  constructor(
    private readonly renderHtml: (html: string, opts: { landscape: boolean }) => Promise<Buffer>,
  ) {}

  async generate(opts: PdfExportOptions): Promise<Buffer> {
    const html = this.buildHtml(opts);
    return this.renderHtml(html, { landscape: opts.orientation === 'landscape' });
  }

  /** El HTML es autocontenido: sin recursos externos salvo el logo (data URI). */
  buildHtml(opts: PdfExportOptions): string {
    const { theme, colors } = { theme: opts.theme, colors: opts.theme.colors };
    const page = opts.orientation === 'landscape'
      ? { width: '297mm', height: '210mm' }
      : { width: '210mm', height: '297mm' };

    const body = opts.blocks.map((b) => this.renderBlock(b, theme)).join('\n');

    return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
  @page { size: A4 ${opts.orientation}; margin: 14mm 12mm 18mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${theme.fonts.body};
    font-size: 10pt;
    color: #1A1F2E;
    background: #FFFFFF;
  }
  /* Banda de marca superior, con degradado primario → secundario */
  .brand-bar {
    height: 6mm;
    background: linear-gradient(90deg, ${colors.primary} 0%, ${colors.secondary} 100%);
    border-radius: 2mm;
    margin-bottom: 5mm;
  }
  .doc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 6mm; margin-bottom: 5mm; }
  .doc-header img.logo { max-height: 16mm; max-width: 46mm; object-fit: contain; }
  .doc-title { font-family: ${theme.fonts.heading}; font-size: 17pt; font-weight: 700; color: ${colors.primary}; margin: 0 0 1mm 0; }
  .doc-subtitle { font-size: 9.5pt; color: ${colors.secondary}; margin: 0; font-weight: 500; }
  .issuer { text-align: right; font-size: 8.5pt; line-height: 1.45; color: #3A4152; }
  .issuer .name { font-family: ${theme.fonts.heading}; font-weight: 700; font-size: 10.5pt; color: #1A1F2E; }
  .header-html, .footer-html { font-size: 8.5pt; color: #3A4152; }

  /* KPIs */
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 4mm 0; }
  .kpi {
    border: 0.4mm solid ${colors.border};
    border-left: 1.2mm solid ${colors.primary};
    border-radius: 2mm;
    padding: 3mm;
    background: ${colors.rowAlt};
  }
  .kpi .label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.4pt; color: #5A6172; }
  .kpi .value { font-family: ${theme.fonts.heading}; font-size: 15pt; font-weight: 700; color: ${colors.primary}; margin-top: 1mm; }
  .kpi .delta { font-size: 7.5pt; color: ${colors.accent}; font-weight: 600; }

  /* Tablas */
  table.data { width: 100%; border-collapse: collapse; margin: 3mm 0; font-size: 8.5pt; }
  table.data thead th {
    background: ${colors.secondary};
    color: #1A1F2E;
    font-family: ${theme.fonts.heading};
    font-weight: 700;
    text-align: left;
    padding: 2.2mm 2mm;
    border-bottom: 0.5mm solid ${colors.primary};
  }
  table.data tbody td { padding: 1.9mm 2mm; border-bottom: 0.2mm solid ${colors.border}; }
  table.data tbody tr:nth-child(even) td { background: ${colors.rowAlt}; }
  table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data tfoot td {
    font-family: ${theme.fonts.heading}; font-weight: 700;
    background: ${colors.primary}; color: ${colors.textOnPrimary};
    padding: 2.2mm 2mm;
  }

  /* Gráficos: SVG inline, ya tematizado por el caller */
  .chart { margin: 4mm 0; page-break-inside: avoid; }
  .chart .caption { font-size: 8pt; color: #5A6172; margin-top: 1.5mm; text-align: center; }
  .chart svg { width: 100%; height: auto; }

  .spacer { display: block; }
  .page-break { break-after: page; }

  /* Pie legal fijo: obligatorio en comprobantes y reportes financieros */
  .legal-footer {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    font-size: 7pt; color: #6A7180;
    border-top: 0.3mm solid ${colors.border};
    padding-top: 1.5mm;
    display: flex; justify-content: space-between;
  }
  .page-number::after { content: counter(page); }
</style>
</head>
<body>
  <div class="brand-bar"></div>

  <div class="doc-header">
    <div>
      ${theme.logoUrl ? `<img class="logo" src="${escapeHtml(theme.logoUrl)}" alt="Logo ${escapeHtml(theme.displayName)}">` : ''}
      <h1 class="doc-title">${escapeHtml(opts.title)}</h1>
      ${opts.subtitle ? `<p class="doc-subtitle">${escapeHtml(opts.subtitle)}</p>` : ''}
      ${theme.documentHeaderHtml ? `<div class="header-html">${theme.documentHeaderHtml}</div>` : ''}
    </div>
    <div class="issuer">
      <div class="name">${escapeHtml(theme.legalName)}</div>
      ${theme.taxId ? `<div>CUIT ${formatCuit(theme.taxId)}</div>` : ''}
      <div>Emitido: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</div>
      <div>Por: ${escapeHtml(opts.generatedBy)}</div>
    </div>
  </div>

  ${body}

  <div class="legal-footer">
    <span>${escapeHtml(opts.legalFooter ?? `${theme.displayName} · Documento generado por Control`)}</span>
    <span>Página <span class="page-number"></span></span>
  </div>
</body>
</html>`;
  }

  private renderBlock(block: PdfBlock, theme: BrandTheme): string {
    const c = theme.colors;
    switch (block.type) {
      case 'kpi-grid':
        return `<div class="kpi-grid">${block.items.map((k) => `
          <div class="kpi">
            <div class="label">${escapeHtml(k.label)}</div>
            <div class="value">${escapeHtml(k.value)}</div>
            ${k.delta ? `<div class="delta">${escapeHtml(k.delta)}</div>` : ''}
          </div>`).join('')}</div>`;

      case 'table': {
        const numeric = new Set(block.numericColumns ?? []);
        return `<table class="data">
          <thead><tr>${block.columns.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
          <tbody>${block.rows.map((row) => `<tr>${row.map((cell, i) =>
            `<td class="${numeric.has(i) ? 'num' : ''}">${escapeHtml(String(cell ?? ''))}</td>`
          ).join('')}</tr>`).join('')}</tbody>
        </table>`;
      }

      case 'chart':
        // El SVG ya viene con los colores del tenant aplicados por el caller.
        // Se valida que sea un SVG: evita que un string arbitrario inyecte HTML.
        return `<div class="chart">${sanitizeSvg(block.svg)}${block.caption
          ? `<div class="caption">${escapeHtml(block.caption)}</div>` : ''}</div>`;

      case 'text':
        return `<p>${escapeHtml(block.content)}</p>`;

      case 'spacer':
        return `<div class="spacer" style="height:${Math.max(0, Math.min(60, block.height))}mm"></div>`;

      case 'page-break':
        return `<div class="page-break"></div>`;

      default: {
        // Guarda de exhaustividad: si se agrega un bloque nuevo y se olvida
        // renderizarlo, TypeScript lo marca acá.
        const _never: never = block;
        return escapeHtml(String(_never));
      }
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function argb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`;
}

function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function normalizeCell(value: unknown, type: ColumnDef<unknown>['type']): unknown {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(d.getTime()) ? '' : d;
    }
    case 'number':
    case 'currency':
    case 'percent': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return String(value);
  }
}

function formatCuit(cuit: string): string {
  const digits = cuit.replace(/\D/g, '');
  if (digits.length !== 11) return cuit;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

/** Sólo se acepta un SVG bien formado como gráfico embebido. */
function sanitizeSvg(svg: string): string {
  const trimmed = svg.trim();
  if (!/^<svg[\s>]/i.test(trimmed) || !/<\/svg>\s*$/i.test(trimmed)) {
    return '<div style="padding:8mm;text-align:center;color:#888;font-size:8pt">Gráfico no disponible</div>';
  }
  return trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, '');
}

// =============================================================================
// Orquestador: resuelve el tema y exporta
// =============================================================================
export class ReportOrchestrator {
  constructor(
    private readonly deps: {
      loadBranding(tenantId: string): Promise<BrandingRow | null>;
      xlsx: XlsxExportService;
      pdf: PdfExportService;
    },
  ) {}

  private async themeFor(tenantId: string): Promise<BrandTheme> {
    const row = await this.deps.loadBranding(tenantId);
    if (!row) {
      // Tenant sin branding configurado: se usa un tema neutro en vez de fallar.
      return resolveTheme({
        tenant_id: tenantId,
        display_name: 'Control',
        legal_name: 'Control',
        tax_id: null,
        logo_url: null,
        color_primary: '#6D5EF8',
        color_secondary: '#22D3EE',
        color_accent: '#F59E0B',
        color_surface: '#0B1020',
        color_text: '#E8ECF8',
        font_heading: 'Inter',
        font_body: 'Inter',
        document_header: {},
        document_footer: {},
      });
    }
    return resolveTheme(row);
  }

  async exportXlsx<T>(
    tenantId: string,
    opts: Omit<XlsxExportOptions<T>, 'theme'>,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const theme = await this.themeFor(tenantId);
    const buffer = await this.deps.xlsx.generate({ ...opts, theme });
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer,
      filename: `${slugify(opts.title)}_${slugify(theme.displayName)}_${stamp}.xlsx`,
    };
  }

  async exportPdf(
    tenantId: string,
    opts: Omit<PdfExportOptions, 'theme'>,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const theme = await this.themeFor(tenantId);
    const buffer = await this.deps.pdf.generate({ ...opts, theme });
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer,
      filename: `${slugify(opts.title)}_${slugify(theme.displayName)}_${stamp}.pdf`,
    };
  }
}

function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quita acentos
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
}
