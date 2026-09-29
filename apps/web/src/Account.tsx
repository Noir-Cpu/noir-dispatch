import { authClient } from "./auth-client";

export function Account() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <p className="meta">Session: checking…</p>;

  if (!session) {
    return (
      <p>
        <button onClick={() => authClient.signIn.social({ provider: "github" })}>Sign in with GitHub</button>{" "}
        <button onClick={() => authClient.signIn.passkey()}>Sign in with a passkey</button>
      </p>
    );
  }

  return (
    <p>
      <span className="meta">Signed in as {session.user.name}</span>{" "}
      <button onClick={() => authClient.passkey.addPasskey()}>Add a passkey</button>{" "}
      <button onClick={() => authClient.signOut()}>Sign out</button>
    </p>
  );
}
