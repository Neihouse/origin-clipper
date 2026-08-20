export default function ClipsLoading() {
  return (
    <main className="review-page" aria-busy="true" aria-live="polite">
      <section className="queue-loading">
        <h1>Loading ORIGIN clip queue…</h1>
        <p>Reading clips, cadence coverage, and the latest publication attempts.</p>
      </section>
    </main>
  );
}
