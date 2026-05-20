"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type RuleCondition = {
  field: string;
  operator: string;
  value: string;
};

type UserRule = {
  id: string;
  name: string;
  natural_language: string;
  conditions: RuleCondition[];
  target_label: string;
  archive: boolean;
  enabled: boolean;
  created_at: string;
};

type RuleSuggestion = {
  natural_language: string;
  name: string;
  conditions: RuleCondition[];
  target_label: string;
  archive: boolean;
};

function conditionLabel(c: RuleCondition): string {
  const opMap: Record<string, string> = {
    contains: "contains",
    starts_with: "starts with",
    ends_with: "ends with",
    equals: "equals",
  };
  return `${c.field} ${opMap[c.operator] ?? c.operator} "${c.value}"`;
}

export function MailRulesPanel() {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<UserRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [showSuggestForm, setShowSuggestForm] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/email-rules`);
      if (!res.ok) throw new Error(`Failed to load rules (${res.status})`);
      const data = (await res.json()) as { rules: UserRule[] };
      setRules(data.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rules.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !hasLoaded.current) {
      hasLoaded.current = true;
      void loadRules();
    }
  }, [open, loadRules]);

  const createRule = async (overrides?: Partial<UserRule & { conditions: RuleCondition[] }>) => {
    const text = overrides?.natural_language ?? input.trim();
    if (!text) return;
    setCreating(true);
    setError("");
    try {
      const body = overrides
        ? {
            natural_language: overrides.natural_language,
            name: overrides.name,
            conditions: overrides.conditions,
            target_label: overrides.target_label,
            archive: overrides.archive,
          }
        : { natural_language: text };

      const res = await fetch(`${API_BASE}/email-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body2 = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body2.detail ?? `Failed to create rule (${res.status})`);
      }
      const rule = (await res.json()) as UserRule;
      setRules((prev) => [rule, ...prev]);
      if (!overrides) setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule.");
    } finally {
      setCreating(false);
    }
  };

  const acceptSuggestion = async (s: RuleSuggestion) => {
    await createRule(s);
    setDismissedSuggestions((prev) => new Set([...prev, s.natural_language]));
  };

  const dismissSuggestion = (s: RuleSuggestion) => {
    setDismissedSuggestions((prev) => new Set([...prev, s.natural_language]));
  };

  const getSuggestions = async () => {
    setSuggesting(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/email-rules/suggestions`);
      if (!res.ok) throw new Error(`Failed to get suggestions (${res.status})`);
      const data = (await res.json()) as { suggestions: RuleSuggestion[] };
      setSuggestions(data.suggestions);
      setDismissedSuggestions(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get suggestions.");
    } finally {
      setSuggesting(false);
    }
  };

  const toggleRule = async (rule: UserRule) => {
    const next = !rule.enabled;
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
    try {
      const res = await fetch(`${API_BASE}/email-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`Failed to update rule (${res.status})`);
      const updated = (await res.json()) as UserRule;
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)));
      setError(err instanceof Error ? err.message : "Failed to update rule.");
    }
  };

  const deleteRule = async (ruleId: string) => {
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
    if (expandedRuleId === ruleId) setExpandedRuleId(null);
    try {
      const res = await fetch(`${API_BASE}/email-rules/${ruleId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to delete rule (${res.status})`);
    } catch (err) {
      void loadRules();
      setError(err instanceof Error ? err.message : "Failed to delete rule.");
    }
  };

  const visibleSuggestions = suggestions.filter(
    (s) => !dismissedSuggestions.has(s.natural_language) &&
      !rules.some((r) => r.natural_language === s.natural_language)
  );

  const activeCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="space-y-2">
      <button
        onClick={() => { setOpen((v) => !v); }}
        className="w-full rounded-[1.4rem] border border-white/8 bg-[rgba(17,19,34,0.82)] px-4 py-2.5 text-left text-sm text-slate-300 transition-colors hover:border-white/15 hover:text-slate-100"
      >
        <span className="font-medium">Routing rules</span>
        <span className="ml-2 text-slate-500">{open ? "▲" : "▼"}</span>
        {!open ? (
          <span className="ml-2 text-xs text-slate-500">
            {rules.length === 0 ? "none" : `${activeCount} of ${rules.length} active`}
          </span>
        ) : null}
      </button>

      {open ? (
        <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
          <CardContent className="space-y-3 p-4">
            {error ? (
              <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
            ) : null}

            {/* Compact rule list */}
            {loading && rules.length === 0 ? (
              <p className="text-xs text-slate-500">Loading rules…</p>
            ) : rules.length === 0 ? (
              <p className="text-xs text-slate-500">No rules yet.</p>
            ) : (
              <div className="space-y-1">
                {rules.map((rule) => (
                  <div key={rule.id} className={`overflow-hidden rounded-[1.1rem] border transition-colors ${
                    rule.enabled ? "border-white/8 bg-[rgba(24,26,42,0.7)]" : "border-white/4 bg-[rgba(20,22,37,0.4)] opacity-50"
                  }`}>
                    {/* Compact row */}
                    <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                      <button
                        className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 text-left"
                        onClick={() => setExpandedRuleId((prev) => prev === rule.id ? null : rule.id)}
                      >
                        <span className="break-words text-xs font-medium text-slate-200">{rule.name}</span>
                        <span className="text-xs text-slate-500">→</span>
                        <span className="break-words text-xs text-fuchsia-300">{rule.target_label}</span>
                        <span className="text-xs text-slate-600">{expandedRuleId === rule.id ? "▲" : "▼"}</span>
                      </button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 shrink-0 rounded-xl px-2 text-xs"
                        onClick={() => void toggleRule(rule)}
                      >
                        {rule.enabled ? "On" : "Off"}
                      </Button>
                    </div>

                    {/* Expanded detail */}
                    {expandedRuleId === rule.id ? (
                      <div className="space-y-2 border-t border-white/6 px-3 pb-2.5 pt-2">
                        <p className="break-words text-xs italic text-slate-400">{rule.natural_language}</p>
                        <div className="flex flex-wrap gap-1">
                          {rule.conditions.map((c, i) => (
                            <Badge key={i} variant="outline" className="rounded-lg text-xs font-normal">
                              {conditionLabel(c)}
                            </Badge>
                          ))}
                          {rule.archive ? (
                            <Badge variant="secondary" className="rounded-lg text-xs">archive</Badge>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 rounded-xl px-2 text-xs text-slate-500 hover:text-red-400"
                          onClick={() => void deleteRule(rule.id)}
                        >
                          Delete rule
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {/* Add rule toggle */}
            <div className="space-y-2">
              <button
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                onClick={() => setShowSuggestForm((v) => !v)}
              >
                {showSuggestForm ? "▲ hide" : "▼ add / suggest rules"}
              </button>

              {showSuggestForm ? (
                <div className="space-y-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void createRule();
                    }}
                    placeholder='e.g. "emails from @missionary.org go to missionary email folder"'
                    rows={2}
                    className="w-full resize-none rounded-[1.1rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="rounded-2xl"
                      onClick={() => void createRule()}
                      disabled={creating || !input.trim()}
                    >
                      {creating ? "Parsing…" : "Add rule"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void getSuggestions()}
                      disabled={suggesting}
                    >
                      {suggesting ? "Analyzing…" : "Suggest"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Suggestions */}
            {visibleSuggestions.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">AI suggestions</p>
                {visibleSuggestions.map((s) => (
                  <div
                    key={s.natural_language}
                    className="rounded-[1.2rem] border border-cyan-300/15 bg-[rgba(32,48,64,0.6)] px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-xs font-medium text-slate-100">{s.name}</div>
                        <div className="flex flex-wrap gap-1">
                          {s.conditions.map((c, i) => (
                            <Badge key={i} variant="outline" className="rounded-lg text-xs font-normal">
                              {conditionLabel(c)}
                            </Badge>
                          ))}
                          <Badge className="rounded-lg border border-fuchsia-300/25 bg-fuchsia-400/12 text-xs text-fuchsia-100">
                            → {s.target_label}
                          </Badge>
                          {s.archive ? (
                            <Badge variant="secondary" className="rounded-lg text-xs">archive</Badge>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        <Button
                          size="sm"
                          className="h-6 rounded-xl px-2 text-xs"
                          onClick={() => void acceptSuggestion(s)}
                          disabled={creating}
                        >
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 rounded-xl px-2 text-xs text-slate-500"
                          onClick={() => dismissSuggestion(s)}
                        >
                          ✕
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
