/**
 * Rendu du markdown des issues (voir `markdown.ts`) avec les tokens du kit. Les cases à cocher
 * sont en lecture seule (cocher écrirait sur GitHub) ; un lien s'ouvre dans le navigateur.
 */
import type { ReactNode } from "react";
import { cadence } from "@cadence/plugin-sdk";
import { cn } from "@cadence/ui";
import { parseInline, parseMarkdown, type Inline } from "./markdown";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text":
        return n.text;
      case "code":
        return (
          <code key={i} className="mono rounded-[4px] bg-p3 px-1 text-small text-clay">
            {n.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold text-tx">
            {renderInline(n.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "link":
        return (
          <button
            key={i}
            type="button"
            onClick={() => void cadence.openExternal(n.href)}
            title={n.href}
            className="text-blue underline-offset-2 hover:underline"
          >
            {renderInline(n.children)}
          </button>
        );
    }
  });
}

const inline = (text: string) => renderInline(parseInline(text));

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cn("flex flex-col gap-3 text-body leading-[1.7] text-tx2", className)}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <p
                key={i}
                className={cn(
                  "font-semibold text-tx",
                  b.level <= 2 ? "mt-1 text-title-sm" : "text-body",
                )}
              >
                {inline(b.text)}
              </p>
            );
          case "paragraph":
            return <p key={i}>{inline(b.text)}</p>;
          case "quote":
            return (
              <p key={i} className="border-l-2 border-line2 pl-3 text-tx3">
                {inline(b.text)}
              </p>
            );
          case "rule":
            return <hr key={i} className="border-line" />;
          case "code":
            return (
              <pre
                key={i}
                className="mono overflow-x-auto rounded-field bg-console px-3 py-2 text-small text-tx2"
              >
                {b.text}
              </pre>
            );
          case "list": {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List
                key={i}
                className={cn("flex flex-col gap-1 pl-5", b.ordered ? "list-decimal" : "list-disc")}
              >
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          case "tasks":
            return (
              <div key={i} className="flex flex-col gap-[7px]">
                {b.items.map((item, j) => (
                  <label key={j} className="flex items-start gap-[9px] text-body-sm text-tx2">
                    <input
                      type="checkbox"
                      checked={item.done}
                      readOnly
                      disabled
                      className="mt-1 size-[13px] accent-clay"
                    />
                    <span className={cn(item.done && "text-tx3 line-through")}>
                      {inline(item.text)}
                    </span>
                  </label>
                ))}
              </div>
            );
        }
      })}
    </div>
  );
}
