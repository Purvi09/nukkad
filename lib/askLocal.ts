// Questions left for whoever knows this city, and the answers they leave.
//
// Deliberately asynchronous. Nobody has to be online, nobody arranges to meet,
// and no contact details change hands — a question sitting unanswered reads as
// an invitation rather than a failure.

import {
  addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp, where,
} from "firebase/firestore";
import { currentUid, db, firebaseReady } from "./firebase";

export type Question = {
  id: string;
  city: string;
  uid: string;
  name: string;
  text: string;
  at: number;
};

export type Answer = {
  id: string;
  questionId: string;
  uid: string;
  name: string;
  text: string;
  at: number;
};

const CONTACT = /(\+?\d[\d\s\-()]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.]{2,})|(https?:\/\/\S+)/;

export const askProblem = (text: string): string | null => {
  const t = text.trim();
  if (t.length < 8) return "Ask a bit more than that.";
  if (t.length > 220) return "Keep it under 220 characters.";
  if (CONTACT.test(t)) return "Leave out contact details — answers come back here.";
  return null;
};

export const askLocal = async (city: string, name: string, text: string) => {
  const store = firebaseReady ? db() : null;
  const uid = await currentUid();
  if (!store || !uid) throw new Error("Questions are not available right now.");

  const problem = askProblem(text);
  if (problem) throw new Error(problem);

  await addDoc(collection(store, "questions"), {
    city, uid, name: name || "someone",
    text: text.trim().replace(/\s+/g, " ").slice(0, 220),
    at: Date.now(),
    asked: serverTimestamp(),
  });
};

export const answerQuestion = async (questionId: string, name: string, text: string) => {
  const store = firebaseReady ? db() : null;
  const uid = await currentUid();
  if (!store || !uid) throw new Error("Answers are not available right now.");

  const problem = askProblem(text);
  if (problem) throw new Error(problem);

  await addDoc(collection(store, "answers"), {
    questionId, uid, name: name || "a local",
    text: text.trim().replace(/\s+/g, " ").slice(0, 220),
    at: Date.now(),
    answered: serverTimestamp(),
  });
};

export const watchQuestions = (city: string, onChange: (qs: Question[]) => void) => {
  const store = firebaseReady ? db() : null;
  if (!store) return () => {};
  const q = query(
    collection(store, "questions"),
    where("city", "==", city),
    orderBy("at", "desc"),
    limit(30),
  );
  return onSnapshot(q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Question, "id">) }))),
    () => onChange([]));
};

export const watchAnswers = (onChange: (as: Answer[]) => void) => {
  const store = firebaseReady ? db() : null;
  if (!store) return () => {};
  // Answers for the whole city in one listener: simpler than one per question,
  // and a city's worth of answers is a small collection.
  const q = query(collection(store, "answers"), orderBy("at", "desc"), limit(120));
  return onSnapshot(q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Answer, "id">) }))),
    () => onChange([]));
};
