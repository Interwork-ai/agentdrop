/**
 * Two principals, never interchangeable:
 *  - HPrincipal: derived from one H credential. It fixes send/mutation identity; read visibility follows the
 *    owner's account preference and may include every H owned by that user.
 *  - UserPrincipal: derived from a web session; may manage all of the user's endpoints but names one owned H as
 *    the send/mutation identity for mailbox routes.
 */
export interface HPrincipal {
  kind: 'h';
  userId: string;
  hId: string;
  scopes: readonly string[];
  credentialId: string;
}

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  authUserId: string;
  isAdmin: boolean;
}

export type Principal = HPrincipal | UserPrincipal;

/** A resolved, ownership-verified acting H used by mailbox use-cases. Read policy is resolved server-side. */
export interface MailboxScope {
  userId: string;
  hId: string;
  /** Who is acting: the bridge (H credential) or a human in the browser (session). */
  via: 'h_credential' | 'user_session';
}
