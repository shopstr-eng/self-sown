"use client";

import { useState } from "react";
import { StorefrontFooterNewsletter as StorefrontFooterNewsletterConfig } from "@/utils/types/types";

interface StorefrontFooterNewsletterProps {
  config: StorefrontFooterNewsletterConfig;
  shopPubkey?: string;
  isPreview?: boolean;
  textColor: string;
  accentColor: string;
  bgColor: string;
  align: "left" | "center" | "right";
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_HEADLINE = "Join our newsletter";
const DEFAULT_BUTTON = "Subscribe";
const DEFAULT_PLACEHOLDER = "you@example.com";
const DEFAULT_SUCCESS = "Thanks for subscribing!";

export default function StorefrontFooterNewsletter({
  config,
  shopPubkey,
  isPreview,
  textColor,
  accentColor,
  bgColor,
  align,
}: StorefrontFooterNewsletterProps) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

  const headline = config.headline?.trim() || DEFAULT_HEADLINE;
  const buttonText = config.buttonText?.trim() || DEFAULT_BUTTON;
  const placeholder = config.placeholder?.trim() || DEFAULT_PLACEHOLDER;
  const successMessage = config.successMessage?.trim() || DEFAULT_SUCCESS;
  const collectPhone = config.collectPhone === true;

  const itemsAlign =
    align === "left"
      ? "items-start"
      : align === "right"
        ? "items-end"
        : "items-center";
  const textAlign =
    align === "left"
      ? "text-left"
      : align === "right"
        ? "text-right"
        : "text-center";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const trimmedEmail = email.trim();
    if (!emailRegex.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    // The editor preview renders this same component; never fire a real
    // subscribe (which would save a contact + enroll a flow) while designing.
    if (isPreview || !shopPubkey) {
      setState("success");
      return;
    }
    setState("submitting");
    try {
      const res = await fetch("/api/storefront/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerPubkey: shopPubkey,
          email: trimmedEmail,
          phone: collectPhone ? phone.trim() : "",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.error || "Something went wrong. Please try again."
        );
      }
      setState("success");
    } catch (err) {
      setState("error");
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
    }
  };

  const inputStyle: React.CSSProperties = {
    borderColor: accentColor + "55",
    backgroundColor: "#ffffff",
    color: "#111111",
  };
  const inputClass =
    "font-body flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none transition focus:border-current";

  return (
    <div className={`flex w-full max-w-md flex-col ${itemsAlign} ${textAlign}`}>
      <h3
        className="font-heading text-lg font-bold"
        style={{ color: textColor }}
      >
        {headline}
      </h3>
      {config.subtext && (
        <p
          className="font-body mt-1 text-sm opacity-60"
          style={{ color: textColor }}
        >
          {config.subtext}
        </p>
      )}

      {state === "success" ? (
        <p className="font-body mt-3 text-sm" style={{ color: accentColor }}>
          {successMessage}
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="mt-3 flex w-full flex-col gap-2 sm:flex-row"
          noValidate
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            required
            placeholder={placeholder}
            aria-label="Email address"
            className={inputClass}
            style={inputStyle}
          />
          {collectPhone && (
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={50}
              placeholder="Phone (optional)"
              aria-label="Phone number"
              className={inputClass}
              style={inputStyle}
            />
          )}
          <button
            type="submit"
            disabled={state === "submitting"}
            className="font-body rounded-lg px-5 py-2.5 text-sm font-bold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: accentColor, color: bgColor }}
          >
            {state === "submitting" ? "Subscribing…" : buttonText}
          </button>
        </form>
      )}

      {error && <p className="font-body mt-2 text-sm text-red-500">{error}</p>}
    </div>
  );
}
