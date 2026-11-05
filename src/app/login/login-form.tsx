"use client";
import { useState } from "react";
import { Button } from "@/components/namurui/button";
export function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "OrderRescue",
        },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Gagal masuk.");
      window.location.assign(new URL("/", window.location.origin).href);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Koneksi gagal.");
      setBusy(false);
    }
  }
  return (
    <div className="rescue-app login-shell" data-theme="dark">
      <div className="login-brand">
        ◇ order<span>rescue</span>
      </div>
      <main className="login-card">
        <p className="eyebrow">OPERATIONS WORKSPACE</p>
        <h1>
          Pesanan berjalan.
          <br />
          Bisnis tetap bergerak.
        </h1>
        <p className="muted">
          Masuk untuk mengelola pasokan dan menjalankan agent pemenuhan pesanan.
        </p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              required
              name="email"
              type="email"
              autoComplete="username"
              placeholder="nama@perusahaan.id"
              maxLength={254}
            />
          </label>
          <label>
            Kata sandi
            <input
              required
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={256}
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <Button loading={busy} type="submit">
            Masuk ke workspace
          </Button>
        </form>
        <p className="login-foot">
          Akses akun disediakan oleh administrator workspace.
        </p>
      </main>
      <span className="login-bottom">
        Order Rescue · Intelligent fulfillment operations
      </span>
    </div>
  );
}
