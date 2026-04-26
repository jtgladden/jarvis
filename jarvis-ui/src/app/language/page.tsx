"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Languages,
  MessageCircle,
  Mic,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const VOCAB_PAGE_SIZE = 50;

type LanguageCode = "tagalog" | "hiligaynon" | "japanese" | "spanish";
type LanguageLevel = "beginner" | "elementary" | "intermediate" | "advanced";
type LanguageTab = "practice" | "conversation" | "voice" | "words" | "phrases" | "review";
type WordPracticeMode = "flashcard" | "target-to-english" | "english-to-target";

type LanguageMetadata = {
  code: LanguageCode;
  name: string;
  local_name: string;
  script_hint: string;
  greeting: string;
  focus_topics: string[];
};

type LanguageProfile = {
  target_languages: LanguageCode[];
  active_language: LanguageCode;
  level: LanguageLevel;
  daily_goal_minutes: number;
  correction_style: "gentle" | "strict" | "immersion";
  romanization: boolean;
  updated_at?: string | null;
};

type LanguagePracticePrompt = {
  id: string;
  mode: "vocabulary" | "conversation" | "writing" | "grammar" | "listening";
  title: string;
  prompt: string;
  target_phrase: string;
  translation: string;
  notes: string;
  expected_answer: string;
};

type LanguageVocabItem = {
  id: string;
  language: LanguageCode;
  phrase: string;
  translation: string;
  notes: string;
  tags: string[];
  review_count: number;
  next_review_at?: string | null;
};

type LanguagePracticeSession = {
  id: string;
  language: LanguageCode;
  mode: "daily" | "conversation" | "vocabulary" | "writing" | "grammar" | "listening";
  minutes: number;
  notes: string;
  created_at?: string | null;
};

type LanguageDashboardResponse = {
  profile: LanguageProfile;
  supported_languages: LanguageMetadata[];
  daily_prompts: LanguagePracticePrompt[];
  daily_focus_words: LanguageVocabItem[];
  vocab: LanguageVocabItem[];
  recent_sessions: LanguagePracticeSession[];
  progress: {
    sessions_count: number;
    minutes_practiced: number;
    vocab_count: number;
    due_reviews: number;
  };
};

type GeneratedPractice = {
  language: LanguageCode;
  level: LanguageLevel;
  title: string;
  overview: string;
  prompts: LanguagePracticePrompt[];
  suggested_minutes: number;
};

type LanguageFeedback = {
  transcript: string;
  target_text: string;
  score: number;
  corrected_text: string;
  feedback: string;
  strengths: string[];
  fixes: string[];
  drills: string[];
};

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  translation?: string;
  correction?: string;
};

type ConversationResponse = {
  reply: string;
  translation: string;
  correction: string;
  suggested_user_reply: string;
  vocab: LanguageVocabItem[];
};

type WordExplanation = {
  word: string;
  translation: string;
  romanization: string;
  part_of_speech: string;
  explanation: string;
  usage_notes: string[];
  examples: Array<{
    target: string;
    romanization: string;
    translation: string;
    note: string;
  }>;
  common_mistakes: string[];
  quick_drill: string;
};

const EMPTY_PROFILE: LanguageProfile = {
  target_languages: ["tagalog", "hiligaynon", "japanese", "spanish"],
  active_language: "tagalog",
  level: "beginner",
  daily_goal_minutes: 15,
  correction_style: "gentle",
  romanization: true,
};

function formatLanguageName(code: LanguageCode, languages: LanguageMetadata[]) {
  return languages.find((language) => language.code === code)?.name ?? code;
}

function formatSessionTime(value: string | null | undefined) {
  if (!value) return "Recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function normalizeAnswer(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:'"()[\]{}]/g, "")
    .replace(/\s+/g, " ");
}

function getWordPracticeKey(item: LanguageVocabItem) {
  return [
    item.language,
    normalizeAnswer(item.phrase),
    normalizeAnswer(item.translation),
  ].join(":");
}

function isVisibleVocabTag(tag: string) {
  return (
    tag !== "word" &&
    tag !== "phrase" &&
    tag !== "common-600" &&
    tag !== "common-v2" &&
    !tag.startsWith("rank-")
  );
}

export default function LanguagePage() {
  const [dashboard, setDashboard] = useState<LanguageDashboardResponse | null>(null);
  const [profile, setProfile] = useState<LanguageProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [vocabSaving, setVocabSaving] = useState(false);
  const [sessionSaving, setSessionSaving] = useState(false);
  const [error, setError] = useState("");
  const [phrase, setPhrase] = useState("");
  const [translation, setTranslation] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [sessionMinutes, setSessionMinutes] = useState("15");
  const [sessionNotes, setSessionNotes] = useState("");
  const [practiceFocus, setPracticeFocus] = useState("");
  const [generatedPractice, setGeneratedPractice] = useState<GeneratedPractice | null>(null);
  const [generatingPractice, setGeneratingPractice] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [writingResponse, setWritingResponse] = useState("");
  const [feedback, setFeedback] = useState<LanguageFeedback | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [speechLoadingId, setSpeechLoadingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [conversationScenario, setConversationScenario] = useState("friendly everyday conversation");
  const [conversationInput, setConversationInput] = useState("");
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<LanguageTab>("practice");
  const [wordPracticeMode, setWordPracticeMode] = useState<WordPracticeMode>("flashcard");
  const [wordPracticeIndex, setWordPracticeIndex] = useState(0);
  const [wordPracticeRevealed, setWordPracticeRevealed] = useState(false);
  const [wordPracticeAnswer, setWordPracticeAnswer] = useState("");
  const [wordPracticeChecked, setWordPracticeChecked] = useState(false);
  const [focusWordIndex, setFocusWordIndex] = useState(0);
  const [focusWordRevealed, setFocusWordRevealed] = useState(false);
  const [wordExplanations, setWordExplanations] = useState<Record<string, WordExplanation>>({});
  const [wordExplanationLoadingId, setWordExplanationLoadingId] = useState<string | null>(null);
  const [vocabSearch, setVocabSearch] = useState("");
  const [visibleVocabCount, setVisibleVocabCount] = useState(VOCAB_PAGE_SIZE);

  const activeLanguage = useMemo(
    () => dashboard?.supported_languages.find((language) => language.code === profile.active_language) ?? null,
    [dashboard?.supported_languages, profile.active_language]
  );

  const dueVocab = useMemo(() => {
    const now = new Date().toISOString();
    return (dashboard?.vocab || []).filter(
      (item) =>
        item.language === profile.active_language &&
        (!item.next_review_at || item.next_review_at <= now)
    );
  }, [dashboard?.vocab, profile.active_language]);
  const activePrompts = generatedPractice?.prompts.length ? generatedPractice.prompts : dashboard?.daily_prompts || [];
  const selectedPrompt = activePrompts.find((prompt) => prompt.id === selectedPromptId) ?? activePrompts[0] ?? null;
  const dailyFocusWords = useMemo(
    () =>
      (dashboard?.daily_focus_words || []).filter(
        (item) => item.language === profile.active_language
      ),
    [dashboard?.daily_focus_words, profile.active_language]
  );
  const currentFocusWord = dailyFocusWords.length
    ? dailyFocusWords[Math.min(focusWordIndex, dailyFocusWords.length - 1)]
    : null;
  const wordVocab = useMemo(
    () =>
      (dashboard?.vocab || []).filter(
        (item) => item.language === profile.active_language && item.tags.includes("word")
      ),
    [dashboard?.vocab, profile.active_language]
  );
  const phraseVocab = useMemo(
    () =>
      (dashboard?.vocab || []).filter(
        (item) => item.language === profile.active_language && !item.tags.includes("word")
      ),
    [dashboard?.vocab, profile.active_language]
  );
  const wordPracticeDeck = useMemo(() => {
    const seen = new Set<string>();
    const deck: LanguageVocabItem[] = [];
    for (const item of wordVocab) {
      const key = getWordPracticeKey(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deck.push(item);
    }
    return deck;
  }, [wordVocab]);
  const activeVocabKind = activeTab === "words" ? "word" : "phrase";
  const activeVocabItems = activeVocabKind === "word" ? wordVocab : phraseVocab;
  const filteredVocabItems = useMemo(() => {
    const query = vocabSearch.trim().toLowerCase();
    if (!query) return activeVocabItems;
    return activeVocabItems.filter((item) =>
      [
        item.phrase,
        item.translation,
        item.notes,
        item.tags.join(" "),
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [activeVocabItems, vocabSearch]);
  const visibleVocabItems = filteredVocabItems.slice(0, visibleVocabCount);
  const currentPracticeWord = wordPracticeDeck.length
    ? wordPracticeDeck[Math.min(wordPracticeIndex, wordPracticeDeck.length - 1)]
    : null;
  const expectedWordAnswer = currentPracticeWord
    ? wordPracticeMode === "english-to-target"
      ? currentPracticeWord.phrase
      : currentPracticeWord.translation
    : "";
  const wordAnswerCorrect =
    Boolean(wordPracticeAnswer.trim()) &&
    normalizeAnswer(wordPracticeAnswer) === normalizeAnswer(expectedWordAnswer);

  const loadDashboard = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Language dashboard request failed with status ${response.status}`);
      }
      const data: LanguageDashboardResponse = await response.json();
      setDashboard(data);
      setProfile(data.profile);
      setSessionMinutes(String(data.profile.daily_goal_minutes));
      setSelectedPromptId((current) => current || data.daily_prompts[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load language practice.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!response.ok) {
        throw new Error(`Profile save failed with status ${response.status}`);
      }
      const saved: LanguageProfile = await response.json();
      setProfile(saved);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save language profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const addVocab = async () => {
    if (!phrase.trim()) return;
    setVocabSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          phrase,
          translation,
          notes,
          tags: Array.from(
            new Set([
              activeVocabKind,
              ...tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            ])
          ),
        }),
      });
      if (!response.ok) {
        throw new Error(`Vocabulary save failed with status ${response.status}`);
      }
      setPhrase("");
      setTranslation("");
      setNotes("");
      setTags("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save vocabulary.");
    } finally {
      setVocabSaving(false);
    }
  };

  const reviewVocab = async (id: string, remembered: boolean) => {
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/vocab/${id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remembered }),
      });
      if (!response.ok) {
        throw new Error(`Review update failed with status ${response.status}`);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update review.");
    }
  };

  const advanceWordPractice = () => {
    setWordPracticeIndex((current) => {
      if (!wordPracticeDeck.length) return 0;
      return (current + 1) % wordPracticeDeck.length;
    });
    setWordPracticeRevealed(false);
    setWordPracticeAnswer("");
    setWordPracticeChecked(false);
  };

  const advanceFocusWord = () => {
    setFocusWordIndex((current) => {
      if (!dailyFocusWords.length) return 0;
      return (current + 1) % dailyFocusWords.length;
    });
    setFocusWordRevealed(false);
  };

  const markFocusWord = async (remembered: boolean) => {
    if (!currentFocusWord) return;
    await reviewVocab(currentFocusWord.id, remembered);
    advanceFocusWord();
  };

  const markWordPractice = async (remembered: boolean) => {
    if (!currentPracticeWord) return;
    await reviewVocab(currentPracticeWord.id, remembered);
    advanceWordPractice();
  };

  useEffect(() => {
    if (wordPracticeIndex > 0 && wordPracticeIndex >= wordPracticeDeck.length) {
      setWordPracticeIndex(0);
    }
  }, [wordPracticeIndex, wordPracticeDeck.length]);

  useEffect(() => {
    setWordPracticeIndex(0);
    setWordPracticeRevealed(false);
    setWordPracticeAnswer("");
    setWordPracticeChecked(false);
    setFocusWordIndex(0);
    setFocusWordRevealed(false);
    setVisibleVocabCount(VOCAB_PAGE_SIZE);
  }, [profile.active_language]);

  useEffect(() => {
    setVisibleVocabCount(VOCAB_PAGE_SIZE);
  }, [activeTab, vocabSearch]);

  useEffect(() => {
    if (focusWordIndex > 0 && focusWordIndex >= dailyFocusWords.length) {
      setFocusWordIndex(0);
    }
  }, [dailyFocusWords.length, focusWordIndex]);

  const logSession = async (mode: LanguagePracticeSession["mode"] = "daily") => {
    setSessionSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          mode,
          minutes: Number(sessionMinutes) || profile.daily_goal_minutes,
          notes: sessionNotes,
        }),
      });
      if (!response.ok) {
        throw new Error(`Session log failed with status ${response.status}`);
      }
      setSessionNotes("");
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log practice.");
    } finally {
      setSessionSaving(false);
    }
  };

  const generatePractice = async () => {
    setGeneratingPractice(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/practice/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          mode: "daily",
          focus: practiceFocus,
          include_saved_vocab: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`AI practice generation failed with status ${response.status}`);
      }
      const data: GeneratedPractice = await response.json();
      setGeneratedPractice(data);
      setSelectedPromptId(data.prompts[0]?.id || "");
      setSessionMinutes(String(data.suggested_minutes || profile.daily_goal_minutes));
      setFeedback(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate practice.");
    } finally {
      setGeneratingPractice(false);
    }
  };

  const requestWritingFeedback = async () => {
    if (!selectedPrompt || !writingResponse.trim()) return;
    setFeedbackLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/feedback/writing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          prompt: selectedPrompt.prompt,
          response: writingResponse,
          correction_style: profile.correction_style,
        }),
      });
      if (!response.ok) {
        throw new Error(`Writing feedback failed with status ${response.status}`);
      }
      setFeedback(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to get writing feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  };

  const playSpeech = async (prompt: LanguagePracticePrompt, speed: "slow" | "normal" = "normal") => {
    const text = prompt.target_phrase || prompt.expected_answer || prompt.prompt;
    if (!text.trim()) return;
    setSpeechLoadingId(`${prompt.id}-${speed}`);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          text,
          speed,
        }),
      });
      if (!response.ok) {
        throw new Error(`Speech generation failed with status ${response.status}`);
      }
      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.onended = () => URL.revokeObjectURL(audioUrl);
      await audio.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to play language audio.");
    } finally {
      setSpeechLoadingId(null);
    }
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support microphone recording.");
      return;
    }
    setError("");
    setRecordedChunks([]);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
          setRecordedChunks((current) => [...current, event.data]);
        }
      };
      recorder.onstop = () => {
        setRecordedChunks(chunks);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setMediaRecorder(recorder);
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to access the microphone.");
    }
  };

  const stopRecording = () => {
    mediaRecorder?.stop();
    setRecording(false);
    setMediaRecorder(null);
  };

  const requestPronunciationFeedback = async () => {
    if (!selectedPrompt || !recordedChunks.length) return;
    setFeedbackLoading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("language", profile.active_language);
      form.append("level", profile.level);
      form.append("target_text", selectedPrompt.target_phrase || selectedPrompt.expected_answer || selectedPrompt.prompt);
      form.append("audio", new Blob(recordedChunks, { type: "audio/webm" }), "practice.webm");
      const response = await fetch(`${API_BASE}/languages/feedback/pronunciation`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`Pronunciation feedback failed with status ${response.status}`);
      }
      setFeedback(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to get pronunciation feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  };

  const sendConversationMessage = async (messageOverride?: string) => {
    const message = (messageOverride ?? conversationInput).trim();
    if (!message) return;
    const nextMessages: ConversationMessage[] = [...conversationMessages, { role: "user", content: message }];
    setConversationMessages(nextMessages);
    setConversationInput("");
    setConversationLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: profile.active_language,
          level: profile.level,
          correction_style: profile.correction_style,
          scenario: conversationScenario,
          message,
          history: conversationMessages.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!response.ok) {
        throw new Error(`Conversation response failed with status ${response.status}`);
      }
      const data: ConversationResponse = await response.json();
      setConversationMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.reply,
          translation: data.translation,
          correction: data.correction,
        },
      ]);
      if (data.suggested_user_reply) {
        setWritingResponse(data.suggested_user_reply);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to continue the conversation.");
    } finally {
      setConversationLoading(false);
    }
  };

  const explainWord = async (item: LanguageVocabItem) => {
    const cached = wordExplanations[item.id];
    if (cached) {
      return;
    }
    setWordExplanationLoadingId(item.id);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/languages/words/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: item.language,
          level: profile.level,
          word: item.phrase,
          translation: item.translation,
          notes: item.notes,
        }),
      });
      if (!response.ok) {
        throw new Error(`Word explanation failed with status ${response.status}`);
      }
      const data: WordExplanation = await response.json();
      setWordExplanations((current) => ({ ...current, [item.id]: data }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to explain that word.");
    } finally {
      setWordExplanationLoadingId(null);
    }
  };

  const toggleTargetLanguage = (code: LanguageCode) => {
    setProfile((current) => {
      const enabled = current.target_languages.includes(code);
      const nextTargets = enabled
        ? current.target_languages.filter((language) => language !== code)
        : [...current.target_languages, code];
      const target_languages = nextTargets.length ? nextTargets : [code];
      return {
        ...current,
        target_languages,
        active_language: target_languages.includes(current.active_language)
          ? current.active_language
          : target_languages[0],
      };
    });
  };

  const renderWordExplanation = (item: LanguageVocabItem) => {
    const explanation = wordExplanations[item.id];
    if (!explanation) return null;
    return (
      <div className="mt-4 rounded-[1.1rem] border border-cyan-300/15 bg-cyan-300/8 p-4">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-white">
            {explanation.word || item.phrase}
            {explanation.romanization ? (
              <span className="ml-2 text-cyan-100">{explanation.romanization}</span>
            ) : null}
          </div>
          <div className="text-sm text-slate-300">{explanation.translation || item.translation}</div>
          {explanation.part_of_speech ? (
            <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{explanation.part_of_speech}</div>
          ) : null}
        </div>
        {explanation.explanation ? (
          <p className="mt-3 text-sm leading-6 text-slate-300">{explanation.explanation}</p>
        ) : null}
        {explanation.usage_notes.length ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Usage</div>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              {explanation.usage_notes.map((note) => (
                <li key={note}>- {note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {explanation.examples.length ? (
          <div className="mt-4 space-y-3">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Examples</div>
            {explanation.examples.map((example, index) => (
              <div key={`${example.target}-${index}`} className="rounded-xl bg-black/20 p-3 text-sm">
                <div className="font-medium text-white">{example.target}</div>
                {example.romanization ? <div className="mt-1 text-cyan-100">{example.romanization}</div> : null}
                <div className="mt-1 text-slate-300">{example.translation}</div>
                {example.note ? <div className="mt-1 text-xs text-slate-500">{example.note}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {explanation.common_mistakes.length ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Watch for</div>
            <ul className="mt-2 space-y-1 text-sm text-slate-300">
              {explanation.common_mistakes.map((mistake) => (
                <li key={mistake}>- {mistake}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {explanation.quick_drill ? (
          <div className="mt-4 rounded-xl border border-white/8 bg-white/5 p-3 text-sm text-cyan-100">
            {explanation.quick_drill}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-[rgb(17,19,34)] px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 rounded-[1.5rem] border border-white/8 bg-[rgba(35,37,58,0.72)] p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-100">
              Language Practice
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Jarvis Language Lab</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Practice Tagalog, Hiligaynon, Japanese, and Spanish with daily prompts, saved phrases, review timing, and lightweight session tracking.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className="rounded-2xl">
              <Link href="/">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
            <Button variant="outline" className="rounded-2xl" onClick={() => void loadDashboard()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-5">
          {[
            ["Minutes", dashboard?.progress.minutes_practiced ?? 0],
            ["Sessions", dashboard?.progress.sessions_count ?? 0],
            ["Words", wordVocab.length],
            ["Phrases", phraseVocab.length],
            ["Due reviews", dashboard?.progress.due_reviews ?? 0],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[1.2rem] border border-white/8 bg-[rgba(24,27,44,0.86)] p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">{label}</div>
              <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-[1.2rem] border border-white/8 bg-[rgba(24,27,44,0.86)] p-2 md:grid-cols-6">
          {[
            ["practice", "Practice", MessageCircle],
            ["conversation", "Conversation", MessageCircle],
            ["voice", "Voice", Mic],
            ["words", "Words", BookOpen],
            ["phrases", "Phrases", Languages],
            ["review", "Review", CheckCircle2],
          ].map(([key, label, Icon]) => {
            const tabKey = key as LanguageTab;
            const TabIcon = Icon as typeof MessageCircle;
            return (
              <Button
                key={tabKey}
                variant={activeTab === tabKey ? "default" : "ghost"}
                className="rounded-xl"
                onClick={() => setActiveTab(tabKey)}
              >
                <TabIcon className="mr-2 h-4 w-4" />
                {label as string}
              </Button>
            );
          })}
        </div>

        {activeTab === "practice" ? (
        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Languages className="h-5 w-5" />
                Profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Active language</label>
                <select
                  className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                  value={profile.active_language}
                  onChange={(event) =>
                    setProfile((current) => ({ ...current, active_language: event.target.value as LanguageCode }))
                  }
                >
                  {(dashboard?.supported_languages || []).map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Target languages</label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(dashboard?.supported_languages || []).map((language) => (
                    <label key={language.code} className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={profile.target_languages.includes(language.code)}
                        onChange={() => toggleTargetLanguage(language.code)}
                      />
                      {language.name}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Level</label>
                  <select
                    className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                    value={profile.level}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, level: event.target.value as LanguageLevel }))
                    }
                  >
                    <option value="beginner">Beginner</option>
                    <option value="elementary">Elementary</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Daily minutes</label>
                  <Input
                    type="number"
                    min={1}
                    max={240}
                    value={profile.daily_goal_minutes}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, daily_goal_minutes: Number(event.target.value) || 15 }))
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Corrections</label>
                  <select
                    className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                    value={profile.correction_style}
                    onChange={(event) =>
                      setProfile((current) => ({
                        ...current,
                        correction_style: event.target.value as LanguageProfile["correction_style"],
                      }))
                    }
                  >
                    <option value="gentle">Gentle</option>
                    <option value="strict">Strict</option>
                    <option value="immersion">Immersion</option>
                  </select>
                </div>
                <label className="mt-6 flex items-center gap-2 rounded-xl border border-white/8 bg-white/5 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={profile.romanization}
                    onChange={(event) =>
                      setProfile((current) => ({ ...current, romanization: event.target.checked }))
                    }
                  />
                  Romanization support
                </label>
              </div>

              <Button className="w-full rounded-2xl" onClick={() => void saveProfile()} disabled={savingProfile}>
                <Save className="mr-2 h-4 w-4" />
                {savingProfile ? "Saving..." : "Save profile"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5" />
                Daily Practice
              </CardTitle>
              {activeLanguage ? (
                <div className="text-sm text-slate-300">
                  {activeLanguage.name} · {activeLanguage.greeting} · {activeLanguage.script_hint}
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[1.2rem] border border-cyan-300/15 bg-cyan-300/8 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-cyan-100">
                      Today&apos;s focus words
                    </div>
                    <div className="mt-1 text-sm text-slate-300">
                      {dailyFocusWords.length
                        ? `${dailyFocusWords.length} words selected for ${activeLanguage?.name || "this language"} today.`
                        : "No focus words yet. Add or seed words to start."}
                    </div>
                  </div>
                  <Button variant="outline" className="rounded-2xl" onClick={() => setActiveTab("words")}>
                    Open Words
                  </Button>
                </div>

                {currentFocusWord ? (
                  <div className="mt-4 rounded-[1.1rem] border border-white/8 bg-black/20 p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-500">
                          {focusWordIndex + 1} of {dailyFocusWords.length}
                        </div>
                        <div className="mt-3 text-3xl font-semibold text-white">{currentFocusWord.phrase}</div>
                        {currentFocusWord.notes ? (
                          <div className="mt-2 text-sm text-cyan-100">{currentFocusWord.notes}</div>
                        ) : null}
                        <div className="mt-4 min-h-10 text-lg text-slate-200">
                          {focusWordRevealed ? currentFocusWord.translation : "Say or type the meaning, then reveal it."}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 md:justify-end">
                        <Button variant="outline" className="rounded-2xl" onClick={() => setFocusWordRevealed((current) => !current)}>
                          {focusWordRevealed ? "Hide" : "Reveal"}
                        </Button>
                      <Button variant="outline" className="rounded-2xl" onClick={advanceFocusWord}>
                        Skip
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={() => void explainWord(currentFocusWord)}
                        disabled={wordExplanationLoadingId === currentFocusWord.id}
                      >
                        {wordExplanationLoadingId === currentFocusWord.id ? "Loading..." : "Examples"}
                      </Button>
                    </div>
                  </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button variant="outline" className="rounded-2xl" onClick={() => void markFocusWord(false)}>
                        Again
                      </Button>
                      <Button className="rounded-2xl" onClick={() => void markFocusWord(true)}>
                      Know it
                    </Button>
                  </div>
                  {renderWordExplanation(currentFocusWord)}
                </div>
              ) : null}
              </div>

              <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4 md:grid-cols-[1fr_auto]">
                <Input
                  value={practiceFocus}
                  onChange={(event) => setPracticeFocus(event.target.value)}
                  placeholder="Optional focus: family, travel, gym, church, work..."
                />
                <Button className="rounded-2xl" onClick={() => void generatePractice()} disabled={generatingPractice}>
                  <Wand2 className="mr-2 h-4 w-4" />
                  {generatingPractice ? "Generating..." : "Generate"}
                </Button>
                {generatedPractice ? (
                  <div className="md:col-span-2 text-sm text-slate-300">
                    <span className="font-medium text-white">{generatedPractice.title}</span> · {generatedPractice.overview}
                  </div>
                ) : null}
              </div>

              {activePrompts.map((prompt) => (
                <div key={prompt.id} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedPromptId(prompt.id)}
                      className="flex items-center gap-2 text-left"
                    >
                      <Badge variant={selectedPromptId === prompt.id ? "default" : "outline"}>{prompt.mode}</Badge>
                      <span className="font-medium text-white">{prompt.title}</span>
                    </button>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void playSpeech(prompt, "slow")} disabled={Boolean(speechLoadingId)}>
                        <Play className="mr-2 h-3 w-3" />
                        {speechLoadingId === `${prompt.id}-slow` ? "Loading..." : "Slow"}
                      </Button>
                      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void playSpeech(prompt, "normal")} disabled={Boolean(speechLoadingId)}>
                        <Play className="mr-2 h-3 w-3" />
                        Natural
                      </Button>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-300">{prompt.prompt}</p>
                  <div className="mt-3 rounded-xl bg-black/20 p-3 text-sm">
                    <div className="font-medium text-cyan-100">{prompt.target_phrase}</div>
                    <div className="mt-1 text-slate-400">{prompt.translation}</div>
                    <div className="mt-2 text-xs text-slate-500">{prompt.notes}</div>
                    {prompt.expected_answer ? <div className="mt-2 text-xs text-slate-400">Model answer: {prompt.expected_answer}</div> : null}
                  </div>
                </div>
              ))}

              <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4 sm:grid-cols-[8rem_1fr_auto]">
                <Input
                  type="number"
                  min={0}
                  max={240}
                  value={sessionMinutes}
                  onChange={(event) => setSessionMinutes(event.target.value)}
                  aria-label="Practice minutes"
                />
                <Input
                  value={sessionNotes}
                  onChange={(event) => setSessionNotes(event.target.value)}
                  placeholder="Practice notes"
                />
                <Button className="rounded-2xl" onClick={() => void logSession("daily")} disabled={sessionSaving}>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Log
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
        ) : null}

        {activeTab === "voice" ? (
        <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5" />
              Voice and Correction
            </CardTitle>
            <div className="text-sm text-slate-300">
              Listen to the current prompt, record yourself, or write an answer and get AI feedback.
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4">
              <div className="grid gap-2">
                <label className="text-xs uppercase tracking-[0.16em] text-slate-400">Practice target</label>
                <select
                  className="h-11 rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] px-3 text-sm text-white"
                  value={selectedPrompt?.id || ""}
                  onChange={(event) => {
                    setSelectedPromptId(event.target.value);
                    setFeedback(null);
                  }}
                >
                  {activePrompts.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                <div className="text-sm font-medium text-white">{selectedPrompt?.target_phrase || selectedPrompt?.title || "Choose a prompt"}</div>
                <div className="mt-2 text-sm leading-6 text-slate-300">{selectedPrompt?.prompt}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="rounded-2xl" onClick={() => selectedPrompt && void playSpeech(selectedPrompt, "slow")} disabled={!selectedPrompt || Boolean(speechLoadingId)}>
                  <Play className="mr-2 h-4 w-4" />
                  Slow audio
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => selectedPrompt && void playSpeech(selectedPrompt, "normal")} disabled={!selectedPrompt || Boolean(speechLoadingId)}>
                  <Play className="mr-2 h-4 w-4" />
                  Natural audio
                </Button>
                <Button className="rounded-2xl" onClick={() => recording ? stopRecording() : void startRecording()} disabled={!selectedPrompt}>
                  {recording ? <Square className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                  {recording ? "Stop recording" : "Record"}
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => void requestPronunciationFeedback()} disabled={!recordedChunks.length || feedbackLoading}>
                  {feedbackLoading ? "Checking..." : "Check pronunciation"}
                </Button>
              </div>
              <div className="space-y-3">
                <textarea
                  className="min-h-28 w-full rounded-xl border border-white/10 bg-[rgba(15,18,30,0.9)] p-3 text-sm text-white outline-none placeholder:text-slate-500"
                  value={writingResponse}
                  onChange={(event) => setWritingResponse(event.target.value)}
                  placeholder="Write your answer here for grammar and naturalness feedback."
                />
                <Button className="rounded-2xl" onClick={() => void requestWritingFeedback()} disabled={!writingResponse.trim() || feedbackLoading}>
                  {feedbackLoading ? "Checking..." : "Check writing"}
                </Button>
              </div>
            </div>

            <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
              {feedback ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-white">AI feedback</div>
                    <Badge>{feedback.score}/100</Badge>
                  </div>
                  {feedback.transcript ? (
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Transcript</div>
                      <div className="mt-1 text-sm text-slate-200">{feedback.transcript}</div>
                    </div>
                  ) : null}
                  {feedback.corrected_text ? (
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Correction</div>
                      <div className="mt-1 text-sm text-cyan-100">{feedback.corrected_text}</div>
                    </div>
                  ) : null}
                  <p className="text-sm leading-6 text-slate-300">{feedback.feedback}</p>
                  {[
                    ["Strengths", feedback.strengths],
                    ["Fixes", feedback.fixes],
                    ["Drills", feedback.drills],
                  ].map(([label, items]) => (
                    Array.isArray(items) && items.length ? (
                      <div key={label as string}>
                        <div className="text-xs uppercase tracking-[0.16em] text-slate-400">{label as string}</div>
                        <ul className="mt-2 space-y-2 text-sm text-slate-300">
                          {items.map((item) => (
                            <li key={item}>- {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null
                  ))}
                </div>
              ) : (
                <div className="grid min-h-64 place-items-center text-center text-sm text-slate-400">
                  Feedback will appear here after you check pronunciation or writing.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        ) : null}

        {activeTab === "conversation" ? (
        <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              Conversation Tutor
            </CardTitle>
            <div className="text-sm text-slate-300">
              Practice back-and-forth. Jarvis replies in the target language, translates, and gives compact corrections.
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                value={conversationScenario}
                onChange={(event) => setConversationScenario(event.target.value)}
                placeholder="Scenario"
              />
              <Button variant="outline" className="rounded-2xl" onClick={() => setConversationMessages([])}>
                Clear chat
              </Button>
            </div>
            <div className="max-h-[28rem] space-y-3 overflow-auto rounded-[1.2rem] border border-white/8 bg-black/20 p-4">
              {conversationMessages.length ? (
                conversationMessages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={`rounded-[1.1rem] border border-white/8 p-3 ${
                      message.role === "user" ? "ml-auto max-w-[85%] bg-cyan-400/10" : "mr-auto max-w-[85%] bg-white/5"
                    }`}
                  >
                    <div className="text-xs uppercase tracking-[0.14em] text-slate-500">
                      {message.role === "user" ? "You" : "Jarvis"}
                    </div>
                    <div className="mt-1 text-sm leading-6 text-white">{message.content}</div>
                    {message.translation ? <div className="mt-2 text-sm text-slate-400">{message.translation}</div> : null}
                    {message.correction ? <div className="mt-2 text-sm text-cyan-100">{message.correction}</div> : null}
                    {message.role === "assistant" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3 rounded-xl"
                        onClick={() =>
                          void playSpeech(
                            {
                              id: `conversation-${index}`,
                              mode: "conversation",
                              title: "Conversation reply",
                              prompt: message.content,
                              target_phrase: message.content,
                              translation: message.translation || "",
                              notes: "",
                              expected_answer: "",
                            },
                            "normal"
                          )
                        }
                      >
                        <Play className="mr-2 h-3 w-3" />
                        Play reply
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="py-10 text-center text-sm text-slate-400">
                  Start with something simple, like “Hello, how are you?” in your active language.
                </div>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                value={conversationInput}
                onChange={(event) => setConversationInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendConversationMessage();
                  }
                }}
                placeholder="Type your message in the target language"
              />
              <Button className="rounded-2xl" onClick={() => void sendConversationMessage()} disabled={conversationLoading || !conversationInput.trim()}>
                {conversationLoading ? "Thinking..." : "Send"}
              </Button>
            </div>
          </CardContent>
        </Card>
        ) : null}

        {activeTab === "words" || activeTab === "phrases" ? (
        <div className="grid gap-6">
          {activeTab === "words" ? (
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5" />
                Word Practice
              </CardTitle>
              <div className="text-sm text-slate-300">
                Practice saved words as flashcards or blind translation checks.
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 md:grid-cols-3">
                {[
                  ["flashcard", "Flashcards"],
                  ["target-to-english", "Word to English"],
                  ["english-to-target", "English to Word"],
                ].map(([mode, label]) => (
                  <Button
                    key={mode}
                    variant={wordPracticeMode === mode ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => {
                      setWordPracticeMode(mode as WordPracticeMode);
                      setWordPracticeRevealed(false);
                      setWordPracticeAnswer("");
                      setWordPracticeChecked(false);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {currentPracticeWord ? (
                <div className="rounded-[1.4rem] border border-white/8 bg-black/20 p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-slate-500">
                        {formatLanguageName(currentPracticeWord.language, dashboard?.supported_languages || [])} · {wordPracticeIndex + 1} of {wordPracticeDeck.length}
                      </div>
                      <div className="mt-4 text-3xl font-semibold text-white">
                        {wordPracticeMode === "english-to-target"
                          ? currentPracticeWord.translation || "No translation saved"
                          : currentPracticeWord.phrase}
                      </div>
                      {wordPracticeMode === "flashcard" ? (
                        <div className="mt-4 min-h-12 text-lg text-cyan-100">
                          {wordPracticeRevealed ? currentPracticeWord.translation || "No translation saved" : "Think of the answer, then reveal it."}
                        </div>
                      ) : (
                        <div className="mt-4 space-y-3">
                          <Input
                            value={wordPracticeAnswer}
                            onChange={(event) => {
                              setWordPracticeAnswer(event.target.value);
                              setWordPracticeChecked(false);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                setWordPracticeChecked(true);
                              }
                            }}
                            placeholder={wordPracticeMode === "english-to-target" ? "Type the word" : "Type the English translation"}
                          />
                          {wordPracticeChecked ? (
                            <div className={`rounded-xl border px-3 py-2 text-sm ${
                              wordAnswerCorrect
                                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                                : "border-amber-400/30 bg-amber-500/10 text-amber-100"
                            }`}>
                              {wordAnswerCorrect ? "Correct." : `Answer: ${expectedWordAnswer || "No answer saved"}`}
                            </div>
                          ) : null}
                        </div>
                      )}
                      {currentPracticeWord.notes ? (
                        <div className="mt-4 text-sm text-slate-400">{currentPracticeWord.notes}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      {wordPracticeMode === "flashcard" ? (
                        <Button variant="outline" className="rounded-2xl" onClick={() => setWordPracticeRevealed((current) => !current)}>
                          {wordPracticeRevealed ? "Hide" : "Reveal"}
                        </Button>
                      ) : (
                        <Button variant="outline" className="rounded-2xl" onClick={() => setWordPracticeChecked(true)}>
                          Check
                        </Button>
                      )}
                      <Button variant="outline" className="rounded-2xl" onClick={advanceWordPractice}>
                        Skip
                      </Button>
                      <Button
                        variant="outline"
                        className="rounded-2xl"
                        onClick={() => void explainWord(currentPracticeWord)}
                        disabled={wordExplanationLoadingId === currentPracticeWord.id}
                      >
                        {wordExplanationLoadingId === currentPracticeWord.id ? "Loading..." : "Examples"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button variant="outline" className="rounded-2xl" onClick={() => void markWordPractice(false)}>
                      Again
                    </Button>
                    <Button className="rounded-2xl" onClick={() => void markWordPractice(true)}>
                      Know it
                    </Button>
                  </div>
                  {renderWordExplanation(currentPracticeWord)}
                </div>
              ) : (
                <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                  Add a few words below, then use this space for flashcards and blind translation.
                </div>
              )}
              {wordVocab.length > wordPracticeDeck.length ? (
                <div className="text-xs text-slate-500">
                  Practice deck uses {wordPracticeDeck.length} unique words from {wordVocab.length} saved word entries.
                </div>
              ) : null}
            </CardContent>
          </Card>
          ) : null}

          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                {activeVocabKind === "word" ? "Words" : "Phrases"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                <Input
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  placeholder={activeVocabKind === "word" ? "Word" : "Phrase"}
                />
                <Input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="Translation" />
                <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Tags, comma separated" />
                <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
                <Button className="rounded-2xl" onClick={() => void addVocab()} disabled={vocabSaving || !phrase.trim()}>
                  <Plus className="mr-2 h-4 w-4" />
                  {vocabSaving ? "Saving..." : activeVocabKind === "word" ? "Save word" : "Save phrase"}
                </Button>
              </div>

              <div className="flex flex-col gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 p-4 md:flex-row md:items-center md:justify-between">
                <Input
                  value={vocabSearch}
                  onChange={(event) => setVocabSearch(event.target.value)}
                  placeholder={`Search ${activeVocabKind === "word" ? "words" : "phrases"}`}
                  className="md:max-w-md"
                />
                <div className="text-sm text-slate-400">
                  Showing {Math.min(visibleVocabItems.length, filteredVocabItems.length)} of {filteredVocabItems.length}
                  {filteredVocabItems.length !== activeVocabItems.length ? ` filtered from ${activeVocabItems.length}` : ""}
                </div>
              </div>

              <div className="space-y-3">
                {visibleVocabItems.map((item) => (
                  <div key={item.id} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-sm text-slate-400">{formatLanguageName(item.language, dashboard?.supported_languages || [])}</div>
                        <div className="mt-1 font-medium text-white">{item.phrase}</div>
                        <div className="mt-1 text-sm text-slate-300">{item.translation}</div>
                        {item.notes ? (
                          <div className="mt-1 text-sm text-cyan-100">{item.notes}</div>
                        ) : null}
                        {item.tags.filter(isVisibleVocabTag).length ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.tags.filter(isVisibleVocabTag).map((tag) => (
                              <Badge key={tag} variant="outline">{tag}</Badge>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void reviewVocab(item.id, false)}>
                          Again
                        </Button>
                        <Button size="sm" className="rounded-xl" onClick={() => void reviewVocab(item.id, true)}>
                          Know it
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-xl"
                          onClick={() => void explainWord(item)}
                          disabled={wordExplanationLoadingId === item.id}
                        >
                          {wordExplanationLoadingId === item.id ? "Loading..." : "Examples"}
                        </Button>
                      </div>
                    </div>
                    {renderWordExplanation(item)}
                  </div>
                ))}
                {visibleVocabCount < filteredVocabItems.length ? (
                  <Button
                    variant="outline"
                    className="w-full rounded-2xl"
                    onClick={() => setVisibleVocabCount((current) => current + VOCAB_PAGE_SIZE)}
                  >
                    Show more
                  </Button>
                ) : null}
                {!activeVocabItems.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    Save {activeVocabKind === "word" ? "individual words" : "phrases"} from practice here; Jarvis will keep a review queue.
                  </div>
                ) : null}
                {activeVocabItems.length > 0 && filteredVocabItems.length === 0 ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    No {activeVocabKind === "word" ? "words" : "phrases"} match that search.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
        ) : null}

        {activeTab === "review" ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-white/8 bg-[rgba(24,27,44,0.86)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5" />
                Review Queue
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                <div className="text-sm font-medium text-white">Due now</div>
                <div className="mt-2 text-3xl font-semibold text-white">{dueVocab.length}</div>
                <div className="mt-1 text-sm text-slate-400">A remembered item moves farther into the future; missed items come back tomorrow.</div>
              </div>
              <div className="space-y-3">
                {(dashboard?.recent_sessions || []).map((session) => (
                  <div key={session.id} className="rounded-[1.2rem] border border-white/8 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-white">
                          {formatLanguageName(session.language, dashboard?.supported_languages || [])} · {session.mode}
                        </div>
                        <div className="mt-1 text-sm text-slate-400">{formatSessionTime(session.created_at)}</div>
                        {session.notes ? <div className="mt-2 text-sm text-slate-300">{session.notes}</div> : null}
                      </div>
                      <Badge>{session.minutes} min</Badge>
                    </div>
                  </div>
                ))}
                {!dashboard?.recent_sessions.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/12 p-5 text-sm text-slate-400">
                    Log your first practice session after finishing today&apos;s prompts.
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
        ) : null}
      </div>
    </main>
  );
}
