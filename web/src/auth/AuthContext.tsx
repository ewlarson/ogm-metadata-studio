import React, { createContext, useCallback, useEffect, useState } from "react";
import { jwtDecode } from "jwt-decode";
import type { CredentialResponse } from "../google-gsi";

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const SESSION_STORAGE_KEY = "aardvark-google-profile";

const RAW_ALLOWED_EMAILS = import.meta.env.VITE_GOOGLE_ALLOWED_EMAILS as string | undefined;
const ALLOWED_EMAILS: string[] =
  RAW_ALLOWED_EMAILS != null && RAW_ALLOWED_EMAILS.trim() !== ""
    ? RAW_ALLOWED_EMAILS.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    : ["ewlarson@gmail.com"];

export interface GoogleUser {
  email: string;
  name: string;
  picture: string;
  idToken: string;
}

interface GoogleIdTokenPayload {
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
}

export interface AuthState {
  user: GoogleUser | null;
  isSignedIn: boolean;
  isLoading: boolean;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

function clearGoogleSessionStorage(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function loadStoredProfile(): GoogleUser | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email: string; name: string; picture: string };
    if (!parsed.email) return null;
    return {
      ...parsed,
      idToken: "",
    };
  } catch {
    return null;
  }
}

function persistProfile(user: GoogleUser): void {
  try {
    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        email: user.email,
        name: user.name,
        picture: user.picture,
      })
    );
  } catch {
    // ignore
  }
}

function parseCredential(credential: string): GoogleUser | null {
  try {
    const payload = jwtDecode<GoogleIdTokenPayload>(credential);
    const email = (payload.email ?? "").toLowerCase();
    const name = payload.name ?? payload.email ?? "";
    const picture = payload.picture ?? "";
    if (!email) return null;
    return { email, name, picture, idToken: credential };
  } catch {
    return null;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/** Poll for window.google.accounts.id (GIS may set it after script onload). */
function waitForGoogleGis(maxMs: number = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.google?.accounts?.id) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const t = window.setInterval(() => {
      if (window.google?.accounts?.id) {
        window.clearInterval(t);
        resolve(true);
        return;
      }
      if (Date.now() - start >= maxMs) {
        window.clearInterval(t);
        resolve(false);
      }
    }, 100);
  });
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<GoogleUser | null>(() => loadStoredProfile());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gisReady, setGisReady] = useState(false);

  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  if (import.meta.env.DEV && typeof window !== "undefined") {
    const hasClientId = Boolean(clientId && clientId.includes("."));
    console.debug("[Auth] VITE_GOOGLE_CLIENT_ID loaded:", hasClientId ? "yes" : "no (add to web/.env and restart dev server)");
  }

  const handleCredential = useCallback((response: CredentialResponse) => {
    const parsed = parseCredential(response.credential);
    if (parsed) {
      if (!ALLOWED_EMAILS.includes(parsed.email.toLowerCase())) {
        console.warn("[Auth] Sign-in blocked for non-allowed email:", parsed.email);
        setUser(null);
        clearGoogleSessionStorage();
        setError("This Google account is not allowed to access this app.");
        return;
      }
      setUser(parsed);
      persistProfile(parsed);
      setError(null);
    } else {
      setError("Invalid sign-in response.");
    }
  }, []);

  useEffect(() => {
    if (!clientId || typeof clientId !== "string" || !clientId.includes(".")) {
      setIsLoading(false);
      setGisReady(false);
      setError("Sign-in not configured. Set VITE_GOOGLE_CLIENT_ID for the Vite build environment.");
      return;
    }
    setError(null);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        setIsLoading(false);
        if (!window.google?.accounts?.id) setError("Google Sign-In failed to load.");
      }
    }, 8000);
    loadScript(GIS_SCRIPT_URL)
      .then(() => waitForGoogleGis(3000))
      .then((hasGis) => {
        if (cancelled || !hasGis || !window.google?.accounts?.id) {
          if (!cancelled && !hasGis) {
            console.warn("[Auth] Google Identity Services script did not become available. Check for blocked requests to accounts.google.com.");
            setError("Google Sign-In script didn't load. Try disabling ad blockers for this site.");
          }
          setIsLoading(false);
          return;
        }
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleCredential,
        });
        setGisReady(true);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[Auth] Failed to load Google Sign-In script:", err);
          setError(err instanceof Error ? err.message : "Failed to load Google Sign-In.");
          setGisReady(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          window.clearTimeout(timeout);
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [clientId, handleCredential]);

  const signIn = useCallback(() => {
    if (!gisReady || !window.google?.accounts?.id) {
      setError(
        clientId
          ? "Google Sign-In script didn't load. Try disabling ad blockers for this site or check the browser console."
          : "Google Sign-In is not available. Set VITE_GOOGLE_CLIENT_ID for the Vite build environment and redeploy."
      );
      return;
    }
    setError(null);
    window.google.accounts.id.prompt();
  }, [gisReady, clientId]);

  const signOut = useCallback(() => {
    setUser(null);
    clearGoogleSessionStorage();
    setError(null);
  }, []);

  const value: AuthState = {
    user,
    isSignedIn: !!user,
    isLoading,
    error,
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export { AuthContext };
