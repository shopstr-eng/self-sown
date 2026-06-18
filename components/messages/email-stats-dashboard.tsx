"use client";

import { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EnvelopeIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import MilkMarketSpinner from "../utility-components/mm-spinner";

interface StepStats {
  step_id: number;
  step_order: number;
  subject: string;
  sent: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  conversions: number;
  open_rate: number;
  click_rate: number;
  conversion_rate: number;
  top_links: Array<{ url: string; clicks: number }>;
}

interface FlowStats {
  flow_id: number;
  name: string;
  flow_type: string;
  status: string;
  sent: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  conversions: number;
  open_rate: number;
  click_rate: number;
  conversion_rate: number;
  steps: StepStats[];
}

const FLOW_TYPE_LABELS: Record<string, string> = {
  welcome_series: "Welcome series",
  post_purchase: "Post-purchase",
  abandoned_cart: "Abandoned cart",
  winback: "Win-back",
  one_time: "One-time email",
};

const pct = (r: number) => `${(Math.max(0, r || 0) * 100).toFixed(1)}%`;

const Metric = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) => (
  <div className="rounded-md border-2 border-black bg-white px-3 py-2">
    <p className="text-lg font-black text-black">{value}</p>
    <p className="text-[11px] font-bold tracking-wide text-gray-500 uppercase">
      {label}
    </p>
    {hint ? <p className="mt-0.5 text-[10px] text-gray-400">{hint}</p> : null}
  </div>
);

const EmailStatsDashboard = () => {
  const { signer, isLoggedIn } = useContext(SignerContext);
  const [flows, setFlows] = useState<FlowStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!signer || !isLoggedIn) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const url = `${window.location.origin}/api/email/flows/stats`;
      const authHeader = await createNip98AuthorizationHeader(
        signer,
        url,
        "GET"
      );
      const res = await fetch("/api/email/flows/stats", {
        method: "GET",
        headers: { Authorization: authHeader },
      });
      if (!res.ok) {
        throw new Error("Failed to load email stats");
      }
      const data = await res.json();
      setFlows(Array.isArray(data.flows) ? data.flows : []);
    } catch (e: any) {
      setError(e?.message || "Failed to load email stats");
    } finally {
      setIsLoading(false);
    }
  }, [signer, isLoggedIn]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isLoggedIn || !signer) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <EnvelopeIcon className="mx-auto mb-3 h-10 w-10 text-gray-400" />
        <p className="font-bold text-gray-600">
          Sign in to view your email stats.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <MilkMarketSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="mb-3 font-bold text-red-600">{error}</p>
        <Button
          className="rounded-md border-2 border-black bg-white font-bold text-black shadow-none"
          size="sm"
          onClick={load}
        >
          <ArrowPathIcon className="h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <EnvelopeIcon className="mx-auto mb-3 h-10 w-10 text-gray-400" />
        <p className="mb-1 font-bold text-gray-600">No email stats yet</p>
        <p className="text-sm text-gray-500">
          Once your email flows start sending, you&apos;ll see how they perform
          here: opens, clicks, and how many orders they drove.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-12">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-black text-black">Email stats</h2>
          <p className="text-sm text-gray-500">
            How your email flows are performing. Opens are estimates; many inbox
            apps hide or pre-load images. Clicks and orders are exact.
          </p>
        </div>
        <Button
          className="rounded-md border-2 border-black bg-white font-bold text-black shadow-none"
          size="sm"
          onClick={load}
        >
          <ArrowPathIcon className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="space-y-3">
        {flows.map((flow) => {
          const isOpen = expanded === flow.flow_id;
          return (
            <div
              key={flow.flow_id}
              className="shadow-neo rounded-md border-2 border-black bg-white"
            >
              <button
                onClick={() => setExpanded(isOpen ? null : flow.flow_id)}
                className="flex w-full items-center justify-between gap-3 p-4 text-left"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-black text-black">
                      {flow.name}
                    </p>
                    <span className="bg-primary-yellow rounded border-2 border-black px-1.5 py-0.5 text-[10px] font-bold text-black">
                      {FLOW_TYPE_LABELS[flow.flow_type] || flow.flow_type}
                    </span>
                    {flow.status !== "active" ? (
                      <span className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500">
                        {flow.status}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {flow.sent} sent · {pct(flow.open_rate)} opened ·{" "}
                    {pct(flow.click_rate)} clicked · {flow.conversions} orders
                  </p>
                </div>
                {isOpen ? (
                  <ChevronUpIcon className="h-5 w-5 flex-shrink-0 text-gray-500" />
                ) : (
                  <ChevronDownIcon className="h-5 w-5 flex-shrink-0 text-gray-500" />
                )}
              </button>

              {isOpen ? (
                <div className="border-t-2 border-black p-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Metric label="Sent" value={flow.sent} />
                    <Metric
                      label="Open rate"
                      value={pct(flow.open_rate)}
                      hint="estimate"
                    />
                    <Metric label="Click rate" value={pct(flow.click_rate)} />
                    <Metric label="Unique clicks" value={flow.unique_clicks} />
                    <Metric label="Orders" value={flow.conversions} />
                    <Metric
                      label="Conversion"
                      value={pct(flow.conversion_rate)}
                    />
                  </div>

                  <div className="mt-4 space-y-3">
                    {flow.steps.map((step) => (
                      <div
                        key={step.step_id}
                        className="rounded-md border-2 border-black bg-gray-50 p-3"
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span className="bg-primary-blue flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-black text-xs font-bold text-white">
                            {step.step_order}
                          </span>
                          <p className="truncate text-sm font-bold text-black">
                            {step.subject || "(No subject)"}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                          <Metric label="Sent" value={step.sent} />
                          <Metric
                            label="Open rate"
                            value={pct(step.open_rate)}
                            hint="estimate"
                          />
                          <Metric
                            label="Click rate"
                            value={pct(step.click_rate)}
                          />
                          <Metric
                            label="Unique clicks"
                            value={step.unique_clicks}
                          />
                          <Metric label="Orders" value={step.conversions} />
                          <Metric
                            label="Conversion"
                            value={pct(step.conversion_rate)}
                          />
                        </div>
                        {step.top_links.length > 0 ? (
                          <div className="mt-3">
                            <p className="mb-1 text-[11px] font-bold tracking-wide text-gray-500 uppercase">
                              Top clicked links
                            </p>
                            <ul className="space-y-1">
                              {step.top_links.map((link) => (
                                <li
                                  key={link.url}
                                  className="flex items-center justify-between gap-2 text-xs"
                                >
                                  <span className="truncate text-blue-700">
                                    {link.url}
                                  </span>
                                  <span className="flex-shrink-0 font-bold text-black">
                                    {link.clicks}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EmailStatsDashboard;
