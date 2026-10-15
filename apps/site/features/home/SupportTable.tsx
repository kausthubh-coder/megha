const ROWS: { works: boolean; feature: string; note: string }[] = [
  { works: true, feature: "Streaming progress", note: "Setup log, commands and the answer show up while the cloud task runs." },
  { works: true, feature: "Follow-ups", note: "The next message in the thread continues the same cloud task." },
  { works: true, feature: "Stop", note: "T3's stop button stops the cloud task." },
  { works: true, feature: "Model picker", note: "Both list the cloud's live models. Claude runs the one you pick; Codex Cloud may still run its default." },
  { works: true, feature: "Environments", note: "Pick the cloud environment for each thread in the composer." },
  { works: true, feature: "Import cloud tasks", note: "List sessions → Import brings a task you started on the web into T3." },
  { works: true, feature: "Apply diff locally", note: "Turn it on and the cloud's changes are applied to your checkout." },
  { works: false, feature: "T3's diff panel", note: "Only after you apply the diff locally. Otherwise the diff shows in the thread." },
  { works: false, feature: "Terminal and previews", note: "You can't open a shell or a preview on the cloud machine." },
  { works: false, feature: "T3 tools in the cloud", note: "The cloud agent can't call T3's own tools." },
];

export function SupportTable() {
  return (
    <table className="mt-8 w-full border-collapse text-left">
      <caption className="sr-only">Features that work with megha, and features that don&apos;t</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Feature</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row, i) => (
          <tr
            key={row.feature}
            className={`grid grid-cols-[1.5rem_1fr] gap-x-2 border-t border-border py-3.5 sm:table-row ${
              !row.works && ROWS[i - 1]?.works ? "border-t-ink/40" : ""
            }`}
          >
            <td className="pt-0.5 sm:w-8 sm:py-3.5 sm:align-top">
              {row.works ? <Yes /> : <No />}
            </td>
            <th scope="row" className="font-semibold sm:w-56 sm:py-3.5 sm:pr-6 sm:align-top">
              {row.feature}
            </th>
            <td className="col-start-2 text-muted sm:py-3.5 sm:align-top">{row.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Yes() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 text-success" fill="none" stroke="currentColor" strokeWidth="1.8" role="img" aria-label="Works">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function No() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8" role="img" aria-label="Doesn't work">
      <path d="M5.5 10h9" strokeLinecap="round" />
    </svg>
  );
}
