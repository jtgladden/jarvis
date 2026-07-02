"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type PhotoprismRef = {
  instance_key: string;
  subject_uid: string;
  subject_name: string;
};

type Person = {
  id: string;
  canonical_name: string;
  aliases: string[];
  photoprism: PhotoprismRef[];
};

type Subject = { uid: string; name: string; photo_count: number };

export default function PeopleIndexPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [instances, setInstances] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newAliases, setNewAliases] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [peopleRes, instancesRes] = await Promise.all([
        fetch(`${API_BASE}/people`),
        fetch(`${API_BASE}/photoprism/instances`),
      ]);
      if (!peopleRes.ok) throw new Error(`Failed to load people (${peopleRes.status})`);
      const peopleJson = await peopleRes.json();
      setPeople(peopleJson.people ?? []);
      setInstances(instancesRes.ok ? await instancesRes.json() : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createPerson = async () => {
    const canonical_name = newName.trim();
    if (!canonical_name) return;
    const aliases = newAliases.split(",").map((a) => a.trim()).filter(Boolean);
    const res = await fetch(`${API_BASE}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name, aliases }),
    });
    if (res.ok) {
      setNewName("");
      setNewAliases("");
      await load();
    } else {
      setError(`Create failed (${res.status})`);
    }
  };

  const deletePerson = async (id: string) => {
    const res = await fetch(`${API_BASE}/people/${id}`, { method: "DELETE" });
    if (res.ok) await load();
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-xl">
          <Link href="/">
            <ArrowLeft className="mr-1.5 h-4 w-4" />Home
          </Link>
        </Button>
        <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />Refresh
        </Button>
      </div>

      <h1 className="mb-4 flex items-center gap-2 text-2xl font-semibold">
        <Users className="h-6 w-6" />People
      </h1>

      {error && <p className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Add a person</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            placeholder="Canonical name (e.g. Sam)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Input
            placeholder="Aliases, comma-separated (e.g. Samuel, Sammy)"
            value={newAliases}
            onChange={(e) => setNewAliases(e.target.value)}
          />
          <Button size="sm" className="rounded-xl" onClick={() => void createPerson()}>
            <Plus className="mr-1.5 h-4 w-4" />Add person
          </Button>
        </CardContent>
      </Card>

      {loading && people.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}

      <div className="space-y-3">
        {people.map((person) => (
          <PersonAdminCard
            key={person.id}
            person={person}
            instances={instances}
            onChanged={load}
            onDelete={() => deletePerson(person.id)}
          />
        ))}
        {!loading && people.length === 0 && (
          <p className="text-sm text-muted-foreground">No people yet. Add one above.</p>
        )}
      </div>
    </main>
  );
}

function PersonAdminCard({
  person,
  instances,
  onChanged,
  onDelete,
}: {
  person: Person;
  instances: string[];
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const [instanceKey, setInstanceKey] = useState(instances[0] ?? "");
  const [subjectUid, setSubjectUid] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  useEffect(() => {
    if (!instanceKey && instances[0]) setInstanceKey(instances[0]);
  }, [instances, instanceKey]);

  const loadSubjects = async () => {
    if (!instanceKey) return;
    setLoadingSubjects(true);
    try {
      const res = await fetch(`${API_BASE}/photoprism/${instanceKey}/subjects`);
      if (res.ok) {
        const json = await res.json();
        setSubjects(json.subjects ?? []);
      }
    } finally {
      setLoadingSubjects(false);
    }
  };

  const addRef = async () => {
    if (!instanceKey || !subjectUid.trim()) return;
    const res = await fetch(`${API_BASE}/people/${person.id}/photoprism`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instance_key: instanceKey,
        subject_uid: subjectUid.trim(),
        subject_name: subjectName.trim(),
      }),
    });
    if (res.ok) {
      setSubjectUid("");
      setSubjectName("");
      await onChanged();
    }
  };

  const removeRef = async (ref: PhotoprismRef) => {
    const res = await fetch(
      `${API_BASE}/people/${person.id}/photoprism/${ref.instance_key}/${ref.subject_uid}`,
      { method: "DELETE" },
    );
    if (res.ok) await onChanged();
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Link href={`/people/${person.id}`} className="text-lg font-medium text-primary hover:underline">
            {person.canonical_name}
          </Link>
          <Button variant="ghost" size="sm" className="rounded-xl text-red-600" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        {person.aliases.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {person.aliases.map((a) => (
              <Badge key={a} variant="secondary">{a}</Badge>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {person.photoprism.map((ref) => (
            <Badge
              key={`${ref.instance_key}:${ref.subject_uid}`}
              variant="outline"
              className="cursor-pointer"
              onClick={() => void removeRef(ref)}
              title="Click to remove"
            >
              {ref.instance_key}: {ref.subject_name || ref.subject_uid} ✕
            </Badge>
          ))}
        </div>

        <div className="rounded-xl border p-2">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Link a PhotoPrism subject</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm"
              value={instanceKey}
              onChange={(e) => setInstanceKey(e.target.value)}
            >
              {instances.length === 0 && <option value="">no instances configured</option>}
              {instances.map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-xl"
              disabled={!instanceKey || loadingSubjects}
              onClick={() => void loadSubjects()}
            >
              {loadingSubjects ? "Loading…" : "Load subjects"}
            </Button>
          </div>

          {subjects.length > 0 && (
            <select
              className="mt-2 h-8 w-full rounded-lg border bg-background px-2 text-sm"
              onChange={(e) => {
                const s = subjects.find((x) => x.uid === e.target.value);
                if (s) {
                  setSubjectUid(s.uid);
                  setSubjectName(s.name);
                }
              }}
              value={subjectUid}
            >
              <option value="">Select a subject…</option>
              {subjects.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name} ({s.photo_count})
                </option>
              ))}
            </select>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              className="w-40"
              placeholder="subject_uid"
              value={subjectUid}
              onChange={(e) => setSubjectUid(e.target.value)}
            />
            <Input
              className="w-40"
              placeholder="subject_name"
              value={subjectName}
              onChange={(e) => setSubjectName(e.target.value)}
            />
            <Button size="sm" className="rounded-xl" onClick={() => void addRef()}>
              <Plus className="mr-1.5 h-4 w-4" />Link
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
