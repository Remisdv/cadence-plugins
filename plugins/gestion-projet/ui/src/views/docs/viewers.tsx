/**
 * Visionneuses des documents du projet : PDF (pdf.js), tableaux (CSV, Excel), images, Markdown et
 * texte. Le contenu arrive du serveur par morceaux (`docs_bytes`), l'iframe du plugin n'ayant pas
 * de réseau : pdf.js tourne donc sur le fil principal (pas de worker), sans `eval`.
 */
import { useEffect, useRef, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Button, Callout, Spinner, cn } from "@cadence/ui";
import { Markdown } from "../../MarkdownText";
import { concatChunks, fromBase64, type DocChunk, type DocTable } from "../../docs";
import { useTool } from "../../useTool";

const message = (e: unknown) => (isCadenceError(e) ? e.message : String(e));

/** Contenu complet d'un document, lu morceau par morceau ; relu quand `sha` change. */
export function useDocBytes(repo: string, path: string, sha: string) {
  const [state, setState] = useState<{ bytes: Uint8Array; mime: string } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    (async () => {
      // Clics rapides d'un document à l'autre : on ne lit (et n'ouvre) que le dernier choisi.
      await new Promise((r) => setTimeout(r, 200));
      if (!alive) return;
      const chunks: Uint8Array[] = [];
      let offset: number | null = 0;
      let mime = "application/octet-stream";
      while (offset !== null) {
        const c: DocChunk = await cadence.call<DocChunk>("docs_bytes", { repo, path, offset });
        chunks.push(fromBase64(c.data));
        mime = c.mime;
        offset = c.next;
        if (!alive) return;
      }
      setState({ bytes: concatChunks(chunks), mime });
    })().catch((e: unknown) => alive && setState({ error: message(e) }));
    return () => {
      alive = false;
    };
  }, [repo, path, sha]);
  return state;
}

function Pending({ label }: { label: string }) {
  return (
    <div className="flex h-40 items-center justify-center gap-2 text-body-sm text-tx3">
      <Spinner size={14} /> {label}
    </div>
  );
}

/* ---------- PDF ---------- */

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

/**
 * Largeur d'une page à 100 % : celle d'une liseuse, quelle que soit la fenêtre. Sur un écran très
 * large, caler la page sur toute la largeur donnait des toiles de 3000 × 4400 pixels (55 Mo
 * chacune), dessinées sur le fil de l'iframe : l'iframe finissait par ne plus s'afficher.
 */
export const PAGE_MAX_WIDTH = 1000;
/** Pixels au plus par toile (≈ 16 Mo) ; au-delà (zoom), la toile est agrandie par CSS. */
export const CANVAS_MAX_PIXELS = 4_000_000;
/** Pages gardées dessinées autour de la zone visible ; les autres rendent leur toile. */
const KEEP_MARGIN = "1500px";

/** Largeur d'une page : ajustée à la place disponible, plafonnée, puis zoomée. */
export function pageWidth(available: number, zoom: number): number {
  const fit = Math.min(PAGE_MAX_WIDTH, Math.max(200, available));
  return Math.round(fit * zoom);
}

/** Échelle de rendu d'une page de `baseWidth` × `baseHeight`, plafonnée à `CANVAS_MAX_PIXELS`. */
export function renderScale(width: number, baseWidth: number, baseHeight: number, dpr: number): number {
  const scale = (width / baseWidth) * dpr;
  const pixels = baseWidth * scale * baseHeight * scale;
  return pixels > CANVAS_MAX_PIXELS ? scale * Math.sqrt(CANVAS_MAX_PIXELS / pixels) : scale;
}

/**
 * File de rendu : une page à la fois. pdf.js tourne sur le fil principal de l'iframe (pas de
 * worker) : plusieurs rendus en parallèle le monopolisaient.
 */
let renderQueue: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): Promise<void> {
  const run = renderQueue.then(job, job);
  renderQueue = run.catch(() => {});
  return run;
}

/** pdf.js chargé à la demande, avec son « worker » sur le fil principal. */
async function loadPdfJs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.mjs"),
  ]);
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  return pdfjs;
}

export function PdfViewer({ repo, path, sha }: { repo: string; path: string; sha: string }) {
  const content = useDocBytes(repo, path, sha);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);

  useEffect(() => {
    if (!content || "error" in content) return;
    let alive = true;
    let task: { destroy(): Promise<void> } | null = null;
    setDoc(null);
    setError(null);
    loadPdfJs()
      .then((pdfjs) => {
        if (!alive) return null;
        // pdf.js garde (et transfère) son tableau : on lui en donne une copie. Pas de réseau dans
        // l'iframe : polices système plutôt que les polices standard de pdf.js.
        const loading = pdfjs.getDocument({ data: content.bytes.slice(), useSystemFonts: true });
        task = loading;
        return loading.promise;
      })
      .then((d) => {
        if (d && alive) setDoc(d);
      })
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [content]);

  // Largeur disponible, regroupée : pas un nouveau rendu de chaque page à chaque pixel.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setAvailable(Math.max(0, Math.floor((el.clientWidth - 32) / 20) * 20));
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    measure();
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  if (content && "error" in content) return <Callout tone="danger">{content.error}</Callout>;
  if (error) return <Callout tone="danger">PDF illisible : {error}</Callout>;

  const width = pageWidth(available, zoom);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-caption text-tx3">
        <span>{doc ? `${doc.numPages} page${doc.numPages > 1 ? "s" : ""}` : "Chargement…"}</span>
        <span className="grow" />
        <Button size="xs" variant="quiet" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Dézoomer">
          −
        </Button>
        <span className="mono w-11 text-center">{Math.round(zoom * 100)} %</span>
        <Button size="xs" variant="quiet" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoomer">
          +
        </Button>
        <Button size="xs" variant="quiet" onClick={() => setZoom(1)}>
          100 %
        </Button>
      </div>
      <div ref={box} className="min-h-0 grow overflow-auto bg-p2 px-4 py-4">
        {!doc || available === 0 ? (
          <Pending label="Ouverture du PDF…" />
        ) : (
          <div className="mx-auto flex w-max min-w-full flex-col items-center gap-3">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage key={`${sha}-${i}`} doc={doc} number={i + 1} width={width} scroller={box.current} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Une page : dessinée (une à la fois) quand elle approche de la zone visible, et sa toile rendue
 * quand elle s'en éloigne, pour borner la mémoire quel que soit le nombre de pages.
 */
function PdfPage({
  doc,
  number,
  width,
  scroller,
}: {
  doc: PdfDoc;
  number: number;
  width: number;
  /** Zone qui défile : la marge de pré-rendu s'applique à elle, pas à la fenêtre. */
  scroller: HTMLElement | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(number <= 2);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e && setNear(e.isIntersecting), {
      root: scroller,
      rootMargin: KEEP_MARGIN,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!near) {
      c.width = 0;
      c.height = 0;
      return;
    }
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    void enqueue(async () => {
      if (cancelled) return;
      const page = await doc.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const scale = renderScale(width, base.width, base.height, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const render = page.render({ canvas: c, viewport });
      task = render;
      await render.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near]);

  // Toile rendue au démontage (changement de document) : pas d'accumulation de mémoire.
  useEffect(() => {
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, []);

  return (
    <div
      ref={holder}
      className="relative bg-white shadow-card"
      style={{ width, height: Math.round(width * ratio) }}
      data-page={number}
    >
      <canvas ref={canvas} className="block h-full w-full" />
      <span className="absolute right-2 bottom-1.5 rounded bg-backdrop/60 px-1.5 text-micro text-white">
        {number}
      </span>
    </div>
  );
}

/* ---------- Tableaux ---------- */

export function TableViewer({ repo, path, sha }: { repo: string; path: string; sha: string }) {
  const [sheet, setSheet] = useState<string | null>(null);
  useEffect(() => setSheet(null), [path, sha]);
  const table = useTool<DocTable>("docs_table", sheet ? { repo, path, sheet } : { repo, path }, sha);
  const t = table.data;

  if (table.error) return <Callout tone="danger">{table.error.message}</Callout>;
  if (!t) return <Pending label="Lecture du tableau…" />;
  const width = Math.max(t.columns.length, ...t.rows.map((r) => r.length));
  return (
    <div className="flex h-full min-h-0 flex-col">
      {t.sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
          {t.sheets.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSheet(s)}
              className={cn(
                "rounded-md px-2.5 py-1 text-caption whitespace-nowrap",
                s === t.sheet ? "bg-p3 text-tx" : "text-tx3 hover:bg-p2 hover:text-tx",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 grow overflow-auto">
        <table className="w-max min-w-full border-collapse text-body-sm">
          <thead className="sticky top-0 z-10 bg-p2">
            <tr>
              <th className="border-b border-line px-2 py-1.5 text-right text-micro font-medium text-tx3">#</th>
              {Array.from({ length: width }, (_, i) => (
                <th key={i} className="border-b border-l border-line px-3 py-1.5 text-left font-medium whitespace-nowrap text-tx">
                  {t.columns[i] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, r) => (
              <tr key={r} className="hover:bg-p2">
                <td className="mono border-b border-line px-2 py-1 text-right text-micro text-tx3">{r + 1}</td>
                {Array.from({ length: width }, (_, i) => (
                  <td key={i} className="max-w-[360px] truncate border-b border-l border-line px-3 py-1 text-tx2" title={row[i]}>
                    {row[i] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-line px-4 py-1.5 text-caption text-tx3">
        {t.total} ligne{t.total > 1 ? "s" : ""}
        {t.total > t.rows.length ? ` · ${t.rows.length} premières affichées` : ""} · {width} colonne
        {width > 1 ? "s" : ""}
      </div>
    </div>
  );
}

/* ---------- Images et texte ---------- */

export function ImageViewer({ repo, path, sha }: { repo: string; path: string; sha: string }) {
  const content = useDocBytes(repo, path, sha);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!content || "error" in content) return;
    const u = URL.createObjectURL(new Blob([content.bytes.slice()], { type: content.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [content]);
  if (content && "error" in content) return <Callout tone="danger">{content.error}</Callout>;
  if (!url) return <Pending label="Chargement de l'image…" />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-p2 p-4">
      <img src={url} alt={path} className="max-h-full max-w-full rounded-md object-contain shadow-card" />
    </div>
  );
}

export function TextViewer({
  repo,
  path,
  sha,
  markdown,
}: {
  repo: string;
  path: string;
  sha: string;
  markdown: boolean;
}) {
  const content = useDocBytes(repo, path, sha);
  if (content && "error" in content) return <Callout tone="danger">{content.error}</Callout>;
  if (!content) return <Pending label="Lecture…" />;
  const text = new TextDecoder("utf-8").decode(content.bytes).replace(/^﻿/, "");
  return (
    <div className="h-full overflow-auto px-6 py-5">
      {markdown ? (
        <div className="mx-auto max-w-[760px]">
          <Markdown source={text} />
        </div>
      ) : (
        <pre className="mono text-body-sm leading-[1.6] whitespace-pre-wrap text-tx2">{text}</pre>
      )}
    </div>
  );
}
