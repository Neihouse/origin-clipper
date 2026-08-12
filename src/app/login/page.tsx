"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <main className="auth-page">
      <form action={formAction} className="auth-card">
        <h1>origin-clipper</h1>
        <p className="auth-subtitle">Private review queue. Sign in to continue.</p>

        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoFocus />

        {state.error ? <p className="auth-error">{state.error}</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
