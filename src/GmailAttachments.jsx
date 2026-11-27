import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, File, FileText, Link2 } from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { threadMessageLinks } from "./messageLinks.js";

function PdfThumbnail({ url }) {
  const container = useRef(null);
  const canvas = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let documentTask;
    let renderTask;

    async function renderPreview() {
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("application/pdf")) return;
        const [pdfjs, data] = await Promise.all([import("pdfjs-dist"), response.arrayBuffer()]);
        if (controller.signal.aborted) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        documentTask = pdfjs.getDocument({ data, isEvalSupported: false });
        const pdf = await documentTask.promise;
        const page = await pdf.getPage(1);
        if (controller.signal.aborted) return;
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(420 / size.width, 840 / size.height) });
        const target = canvas.current;
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        renderTask = page.render({ canvas: target, viewport });
        await renderTask.promise;
        if (!controller.signal.aborted) setReady(true);
      } catch {
        // Keep the PDF icon and download link when a thumbnail can't be rendered.
      }
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      void renderPreview();
    }, { rootMargin: "120px" });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      controller.abort();
      renderTask?.cancel();
      documentTask?.destroy().catch(() => {});
    };
  }, [url]);

  return (
    <div ref={container} className="relative grid h-full place-items-center" aria-hidden="true">
      {!ready && <FileText size={26} className="text-primary/65" />}
      <canvas ref={canvas} className={`absolute inset-x-0 top-0 h-auto w-full ${ready ? "" : "invisible"}`} />
    </div>
  );
}

export function GmailAttachments({ messages, gmailUrl, formatSize }) {
  const files = messages.flatMap((mail) => {
    const attachments = mail.attachments ?? mail.pdfs?.map((pdf) => ({ ...pdf, mimeType: "application/pdf" })) ?? [];
    const collection = mail.attachments ? "attachments" : "pdfs";
    const messageId = encodeURIComponent(mail.id);
    return attachments.map((file) => ({
      ...file,
      key: `${mail.id}:${file.index}`,
      href: file.downloadable
        ? `${gmailUrl}/messages/${messageId}/${collection}/${file.index}`
        : `https://mail.google.com/mail/u/0/#all/${messageId}`,
    }));
  });
  if (!files.length) return null;

  return (
    <section className="space-y-2" aria-label="Email attachments">
      <h4 className="text-sm font-semibold">Attachments</h4>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2">
        {files.map(({ key, name, mimeType, href, size, downloadable }) => {
          const isPdf = mimeType === "application/pdf";
          const FileIcon = isPdf ? FileText : File;
          const ActionIcon = downloadable ? Download : ExternalLink;
          return (
            <li key={key} className="min-w-0">
              <a href={href} target="_blank" rel="noopener noreferrer" title={name}
                className="card h-full overflow-hidden rounded-lg border border-base-300 bg-base-100 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
                <div className="h-24 overflow-hidden border-b border-base-300 bg-base-200">
                  {isPdf && downloadable ? (
                    <PdfThumbnail key={href} url={href} />
                  ) : (
                    <div className="grid h-full place-items-center text-primary/65">
                      <FileIcon size={26} aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 p-2">
                  <span className="min-w-0 grow">
                    <span className="block truncate text-xs font-semibold">{name}</span>
                    <span className="block text-[11px] text-base-content/70">
                      {isPdf && "PDF · "}
                      {downloadable ? (size == null ? "Download" : formatSize(size)) : "Open in Gmail"}
                    </span>
                  </span>
                  <ActionIcon size={14} className="shrink-0 text-primary" aria-hidden="true" />
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function GmailLinks({ messages }) {
  return <ThreadLinks messages={messages} label="Email links" />;
}

// Links found in a thread's messages (Gmail `body` or Instagram `text`), one row per destination.
export function ThreadLinks({ messages, label }) {
  const links = threadMessageLinks(messages);
  if (!links.length) return null;

  return (
    <section className="space-y-2" aria-label={label}>
      <h4 className="text-sm font-semibold">Links</h4>
      <ul className="list rounded-lg border border-base-300 bg-base-100">
        {links.map(({ url, label }) => (
          <li key={url} className="list-row p-0">
            <a href={url} target="_blank" rel="noopener noreferrer" title={url}
              className="col-span-full flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-primary hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-primary">
              <Link2 size={15} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 grow">
                <span className="block truncate text-xs font-semibold">{label}</span>
                <span className="block truncate text-[11px] text-base-content/70">{new URL(url).hostname}</span>
              </span>
              <ExternalLink size={14} className="shrink-0" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
