import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type Auth as FirebaseAuth,
  type User as FirebaseUser,
} from "firebase/auth";

// Firebase web config (client-side). Consider moving to VITE_FIREBASE_* env vars.
const firebaseConfig = {
  apiKey: "AIzaSyAc6stBliPNzW9Zqt7ncy8Q5oMkXzA_0y0",
  authDomain: "panyero-16259.firebaseapp.com",
  databaseURL: "https://panyero-16259-default-rtdb.firebaseio.com",
  projectId: "panyero-16259",
  storageBucket: "panyero-16259.firebasestorage.app",
  messagingSenderId: "375624897863",
  appId: "1:375624897863:web:92c65c3c5a8a392239e862",
  measurementId: "G-TFBXKGZC24",
};

let app: FirebaseApp | null = null;
let auth: FirebaseAuth | null = null;

export function getFirebaseAuth(): FirebaseAuth | null {
  try {
    if (!app) app = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);
    if (!auth) auth = getAuth(app);
    return auth;
  } catch {
    return null;
  }
}

export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export async function firebaseSignIn(email: string, password: string): Promise<FirebaseUser> {
  const a = getFirebaseAuth();
  if (!a) throw new Error("Firebase auth is unavailable.");
  const cred = await signInWithEmailAndPassword(a, email.trim(), password);
  return cred.user;
}

export async function firebaseCreate(email: string, password: string): Promise<FirebaseUser> {
  const a = getFirebaseAuth();
  if (!a) throw new Error("Firebase auth is unavailable.");
  const cred = await createUserWithEmailAndPassword(a, email.trim(), password);
  return cred.user;
}

export async function firebaseSignOut(): Promise<void> {
  const a = getFirebaseAuth();
  if (a) await signOut(a);
}

export function firebaseUserKey(user: FirebaseUser): string {
  // Stable game identifier for Firebase users; keeps it compatible with string phone keys.
  const email = (user.email || "").trim().toLowerCase();
  if (email) return email;
  return `fb_${user.uid}`;
}

export { onAuthStateChanged, type FirebaseUser };
