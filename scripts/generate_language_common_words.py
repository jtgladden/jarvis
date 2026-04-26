import json
import os
import re
import csv
from pathlib import Path
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

TOTAL_WORDS = 600
AI_BATCH_SIZE = 100
OUTPUT_PATH = Path("app/language_common_words.json")

FREQUENCY_URLS = {
    "tagalog": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/tl/tl_50k.txt",
    "japanese": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/ja/ja_50k.txt",
    "spanish": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/es/es_50k.txt",
}
HILIGAYNON_KAIKKI_URL = "https://kaikki.org/dictionary/Hiligaynon/kaikki.org-dictionary-Hiligaynon.jsonl"
ADSONANT_JAPANESE_CSV_URL = "https://www.adsonant.com/word-frequency-lists/Adsonant-1000-most-common-japanese-words.csv"


def normalize_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def read_url_text(url: str) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.adsonant.com/resources/japanese/1000-most-common-words/",
        },
    )
    with urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


KANA_ROMAJI = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "wo", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ゃ": "ya", "ゅ": "yu", "ょ": "yo",
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
}

KANA_DIGRAPHS = {
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
}


def kana_to_romaji(value: str) -> str:
    text = value.strip()
    result: list[str] = []
    i = 0
    double_next = False
    while i < len(text):
        char = text[i]
        if char == "っ":
            double_next = True
            i += 1
            continue
        pair = text[i : i + 2]
        if pair in KANA_DIGRAPHS:
            romaji = KANA_DIGRAPHS[pair]
            i += 2
        else:
            romaji = KANA_ROMAJI.get(char, char)
            i += 1
        if double_next and romaji and romaji[0].isalpha():
            romaji = romaji[0] + romaji
            double_next = False
        result.append(romaji)
    return "".join(result)


def load_frequency_words(language: str) -> list[str]:
    text = read_url_text(FREQUENCY_URLS[language])
    words: list[str] = []
    seen = set()
    for line in text.splitlines():
        word = line.split(" ", 1)[0].strip()
        if not word or normalize_key(word) in seen:
            continue
        seen.add(normalize_key(word))
        words.append(word)
        if len(words) >= TOTAL_WORDS:
            break
    return words


def load_hiligaynon_words() -> list[dict]:
    words: list[dict] = []
    seen = set()
    text = read_url_text(HILIGAYNON_KAIKKI_URL)
    for line in text.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        word = str(entry.get("word") or "").strip()
        pos = str(entry.get("pos") or "other").strip() or "other"
        if not word or " " in word or normalize_key(word) in seen or pos == "name":
            continue
        senses = entry.get("senses") or []
        glosses: list[str] = []
        for sense in senses:
            for gloss in sense.get("glosses") or []:
                if gloss and gloss not in glosses:
                    glosses.append(gloss)
        if not glosses:
            continue
        seen.add(normalize_key(word))
        words.append(
            {
                "rank": len(words) + 1,
                "word": word,
                "reading": "",
                "translation": "; ".join(glosses[:2]),
                "part_of_speech": pos,
                "notes": "Dictionary-backed Hiligaynon starter word.",
            }
        )
        if len(words) >= TOTAL_WORDS:
            break
    if len(words) < TOTAL_WORDS:
        raise RuntimeError(f"hiligaynon: expected {TOTAL_WORDS}, got {len(words)}")
    return words


def load_japanese_words_from_csv() -> list[dict]:
    text = read_url_text(ADSONANT_JAPANESE_CSV_URL)
    words: list[dict] = []
    seen = set()
    for row in csv.DictReader(text.splitlines()):
        word = (row.get("word") or "").strip()
        hiragana = (row.get("hiragana") or "").strip()
        english = (row.get("english") or "").strip()
        if not word or not hiragana or not english:
            continue
        key = normalize_key(word)
        if key in seen:
            continue
        seen.add(key)
        reading = kana_to_romaji(hiragana)
        words.append(
            {
                "rank": len(words) + 1,
                "word": word,
                "reading": reading,
                "translation": english,
                "part_of_speech": "other",
                "notes": f"Kana: {hiragana}. Romaji: {reading}.",
            }
        )
        if len(words) >= TOTAL_WORDS:
            break
    if len(words) < TOTAL_WORDS:
        raise RuntimeError(f"japanese: expected {TOTAL_WORDS}, got {len(words)}")
    return words


def coerce_json_object(content: str) -> dict:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(content[start : end + 1])
        raise


def enrich_words(client: OpenAI, language: str, words: list[str]) -> list[dict]:
    language_name = {
        "tagalog": "Tagalog",
        "japanese": "Japanese",
        "spanish": "Spanish",
    }[language]
    enriched: list[dict] = []
    for offset in range(0, len(words), AI_BATCH_SIZE):
        batch = words[offset : offset + AI_BATCH_SIZE]
        response = client.chat.completions.create(
            model=os.getenv("OPENAI_LANGUAGE_MODEL", "gpt-4.1-mini"),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Enrich frequency-list words for a language learning app. Return strict JSON. "
                        "Preserve input order and return one item per input word. Translations should be concise. "
                        "For Japanese, reading must be Hepburn romaji so a beginner who cannot read kana or kanji can practice."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "language": language_name,
                            "language_code": language,
                            "words": batch,
                            "json_shape": {
                                "items": [
                                    {
                                        "word": "same word from input",
                                        "reading": "romaji for Japanese, otherwise optional pronunciation/readable form",
                                        "translation": "English translation",
                                        "part_of_speech": "noun|verb|adjective|adverb|pronoun|preposition|conjunction|particle|interjection|other",
                                        "notes": "short usage note, optional",
                                    }
                                ]
                            },
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            temperature=0.1,
            max_tokens=8000,
            response_format={"type": "json_object"},
        )
        data = coerce_json_object(response.choices[0].message.content or "{}")
        by_word = {normalize_key(str(item.get("word") or "")): item for item in data.get("items") or []}
        for word in batch:
            item = by_word.get(normalize_key(word), {})
            reading = str(item.get("reading") or "").strip()
            notes = str(item.get("notes") or "").strip()
            if language == "japanese" and reading:
                notes = f"Romaji: {reading}" + (f". {notes}" if notes else "")
            enriched.append(
                {
                    "rank": len(enriched) + 1,
                    "word": word,
                    "reading": reading,
                    "translation": str(item.get("translation") or "").strip(),
                    "part_of_speech": str(item.get("part_of_speech") or "other").strip() or "other",
                    "notes": notes,
                }
            )
        print(f"{language}: {len(enriched)}/{len(words)}", flush=True)
    return enriched


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required.")
    client = OpenAI(api_key=api_key)

    output = {
        "tagalog": enrich_words(client, "tagalog", load_frequency_words("tagalog")),
        "hiligaynon": load_hiligaynon_words(),
        "japanese": load_japanese_words_from_csv(),
        "spanish": enrich_words(client, "spanish", load_frequency_words("spanish")),
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
