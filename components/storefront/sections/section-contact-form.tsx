import { useState } from "react";
import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import FormattedText from "../formatted-text";
import SectionElementFlow, {
  headingSizeClass,
  bodySizeClass,
} from "./section-elements";

interface SectionContactFormProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopPubkey: string;
  shopName: string;
  isPreview?: boolean;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const DEFAULT_SUCCESS = "Thanks for reaching out! We'll get back to you soon.";
const DEFAULT_SUBSCRIBE_SUCCESS = "Thanks for subscribing!";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SectionContactForm({
  section,
  colors,
  shopPubkey,
  shopName,
  isPreview,
}: SectionContactFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

  const isSubscription = section.contactFormMode === "subscription";
  // Email is always shown and required. Name/Phone/Message are optional inputs
  // the seller can hide; undefined defaults to shown (legacy contact form).
  const showName = section.showNameField !== false;
  const showPhone = section.showPhoneField !== false;
  const showMessage = section.showMessageField !== false;

  const buttonLabel =
    section.ctaText?.trim() || (isSubscription ? "Subscribe" : "Send Message");
  const successMessage =
    section.successMessage?.trim() ||
    (isSubscription ? DEFAULT_SUBSCRIBE_SUCCESS : DEFAULT_SUCCESS);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();

    // Email is always required; only validate the fields that are visible.
    if (!trimmedEmail) {
      setError("Please enter your email.");
      return;
    }
    if (!emailRegex.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    // The editor preview renders this same component; never fire a real send
    // (which would email the seller or save a contact) while designing.
    if (isPreview) {
      setState("success");
      return;
    }

    setState("submitting");
    try {
      const endpoint = isSubscription
        ? "/api/storefront/subscribe"
        : "/api/storefront/contact-form";
      const body = isSubscription
        ? {
            sellerPubkey: shopPubkey,
            email: trimmedEmail,
            phone: showPhone ? trimmedPhone : "",
          }
        : {
            sellerPubkey: shopPubkey,
            name: showName ? trimmedName : "",
            email: trimmedEmail,
            phone: showPhone ? trimmedPhone : "",
            message: showMessage ? message.trim() : "",
            shopName,
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    borderColor: colors.primary + "33",
    backgroundColor: "var(--sf-bg, #ffffff)",
    color: "var(--sf-text)",
  };
  const inputClass =
    "font-body w-full rounded-lg border px-4 py-3 text-base outline-none transition focus:border-current";
  const labelClass = "font-body mb-1 block text-sm font-semibold opacity-80";

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 md:px-6">
      <SectionElementFlow
        section={section}
        colors={colors}
        slots={{
          heading: section.heading && (
            <FormattedText
              text={section.heading}
              as="h2"
              className={`font-heading mb-4 text-center ${headingSizeClass(
                section,
                "text-3xl"
              )} font-bold`}
              style={{ color: section.headingColor || "var(--sf-text)" }}
            />
          ),
          body: section.body && (
            <FormattedText
              text={section.body}
              as="p"
              className={`font-body mx-auto mb-8 max-w-xl text-center ${bodySizeClass(
                section,
                "text-lg"
              )} opacity-70`}
            />
          ),
          content: (
            <div
              className="mx-auto max-w-md rounded-xl border p-6 md:p-8"
              style={{ borderColor: colors.primary + "22" }}
            >
              {state === "success" ? (
                <p
                  className="font-body py-8 text-center text-lg"
                  style={{ color: colors.accent }}
                >
                  {successMessage}
                </p>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                  {showName && (
                    <div>
                      <label className={labelClass} htmlFor="contact-form-name">
                        Name
                      </label>
                      <input
                        id="contact-form-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                        className={inputClass}
                        style={inputStyle}
                        placeholder="Your name"
                      />
                    </div>
                  )}

                  <div>
                    <label className={labelClass} htmlFor="contact-form-email">
                      Email<span style={{ color: colors.accent }}> *</span>
                    </label>
                    <input
                      id="contact-form-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      maxLength={254}
                      required
                      className={inputClass}
                      style={inputStyle}
                      placeholder="you@example.com"
                    />
                  </div>

                  {showPhone && (
                    <div>
                      <label
                        className={labelClass}
                        htmlFor="contact-form-phone"
                      >
                        Phone
                      </label>
                      <input
                        id="contact-form-phone"
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        maxLength={50}
                        className={inputClass}
                        style={inputStyle}
                        placeholder="(555) 555-5555"
                      />
                    </div>
                  )}

                  {showMessage && (
                    <div>
                      <label
                        className={labelClass}
                        htmlFor="contact-form-message"
                      >
                        Message
                      </label>
                      <textarea
                        id="contact-form-message"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        maxLength={2000}
                        rows={4}
                        className={`${inputClass} resize-y`}
                        style={inputStyle}
                        placeholder="How can we help?"
                      />
                    </div>
                  )}

                  {error && (
                    <p className="font-body text-sm text-red-600">{error}</p>
                  )}

                  <button
                    type="submit"
                    disabled={state === "submitting"}
                    className="font-body w-full rounded-lg px-6 py-3 text-base font-bold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    style={{
                      backgroundColor: colors.primary,
                      color: colors.background,
                    }}
                  >
                    {state === "submitting"
                      ? isSubscription
                        ? "Subscribing…"
                        : "Sending…"
                      : buttonLabel}
                  </button>
                </form>
              )}
            </div>
          ),
        }}
      />
    </div>
  );
}
