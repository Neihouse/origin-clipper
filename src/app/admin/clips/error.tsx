"use client";

export default function ClipsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="review-page">
      <section className="queue-error" role="alert">
        <h1>The publishing workspace could not load</h1>
        <p>
          No publishing state was changed. Retry the read; if it fails again, inspect the database
          connection and deployment logs before taking a publishing action.
        </p>
        <button type="button" onClick={reset} className="workflow-button">
          Retry loading publishing data
        </button>
      </section>
    </main>
  );
}
