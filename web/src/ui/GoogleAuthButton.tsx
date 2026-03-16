import React from "react";
import { useAuth } from "../auth/useAuth";

export const GoogleAuthButton: React.FC = () => {
  const { user, isSignedIn, isLoading, error, signIn, signOut } = useAuth();

  if (isLoading) {
    return (
      <span className="text-xs text-slate-500 dark:text-slate-400 px-2 py-1 whitespace-nowrap">Loading…</span>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <span className="text-xs text-amber-600 dark:text-amber-400 max-w-[200px] truncate" title={error}>
          {error}
        </span>
        <button
          type="button"
          onClick={signIn}
          className="rounded-md border border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
        >
          Sign in
        </button>
      </div>
    );
  }

  if (isSignedIn && user) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 min-w-0 max-w-[140px]">
          {user.picture ? (
            <img
              src={user.picture}
              alt=""
              className="h-6 w-6 rounded-full flex-shrink-0"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="text-[10px] text-slate-600 dark:text-slate-300 truncate" title={user.email}>
            {user.name || user.email}
          </span>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="rounded-md border border-transparent px-2 py-1 text-[10px] text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800/70 hover:text-slate-700 dark:hover:text-slate-200"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={signIn}
      className="rounded-md border border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors whitespace-nowrap"
      aria-label="Sign in with Google"
    >
      Sign in with Google
    </button>
  );
};
