import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** Without a project id there is nothing to talk to; the game still runs. */
export const firebaseReady = Boolean(firebaseConfig.projectId && firebaseConfig.apiKey);

let app: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;
let cachedAuth: Auth | null = null;
let cachedStorage: FirebaseStorage | null = null;

const ensureApp = () => {
  if (!firebaseReady) return null;
  if (!app) app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return app;
};

export const db = () => {
  const instance = ensureApp();
  if (!instance) return null;
  if (!cachedDb) cachedDb = getFirestore(instance);
  return cachedDb;
};

export const auth = () => {
  const instance = ensureApp();
  if (!instance) return null;
  if (!cachedAuth) cachedAuth = getAuth(instance);
  return cachedAuth;
};

export const storage = () => {
  const instance = ensureApp();
  if (!instance) return null;
  if (!cachedStorage) cachedStorage = getStorage(instance);
  return cachedStorage;
};

/**
 * Everyone plays signed in, anonymously. No sign-up wall, but a stable id — so
 * a memory can be deleted by whoever left it, and nobody else.
 */
let signingIn: Promise<string | null> | null = null;

export const currentUid = async (): Promise<string | null> => {
  const instance = auth();
  if (!instance) return null;
  if (instance.currentUser) return instance.currentUser.uid;

  if (!signingIn) {
    signingIn = new Promise<string | null>((resolve) => {
      const stop = onAuthStateChanged(instance, (user) => {
        if (user) { stop(); resolve(user.uid); }
      });
      signInAnonymously(instance).catch(() => { stop(); resolve(null); });
    }).catch(() => null);
  }
  return signingIn;
};
