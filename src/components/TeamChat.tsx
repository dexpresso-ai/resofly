import { useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { ChatShell } from './teamchat/ChatShell';
import type { TeamChatApi } from './teamchat/useTeamChat';

/**
 * Teamchat — interne chat tussen de leden van één organisatie, met de opbouw
 * en de functies van Microsoft Teams.
 *
 * - `useTeamChat` draait op App-niveau: één realtime-abonnement + één
 *   presence-kanaal. Voedt de sidebar-badge, de pagina, het zwevende paneel en
 *   de meldingen.
 * - `TeamChatPage` = de volledige pagina: app-rail (Activiteit, Chat, Teams,
 *   Bestanden, Opgeslagen), lijst en gesprek naast elkaar; op een telefoon één
 *   venster tegelijk.
 * - `TeamChatDock` = zwevend paneel rechtsonder (één venster, met tabbladen).
 * - `TeamChatToasts` = een banner bij een nieuw bericht terwijl je elders bent.
 *
 * De onderdelen staan in ./teamchat; de opmaak in src/styles/teamchat.css.
 */

export { useTeamChat } from './teamchat/useTeamChat';
export type { TeamChatApi, ChatRealtimeEvent } from './teamchat/useTeamChat';
export { TeamChatToasts } from './teamchat/ChatShell';

/** Volledige chatpagina (menu-item 'chat'). */
export function TeamChatPage({ api, active = true }: { api: TeamChatApi; active?: boolean }) {
  return <ChatShell api={api} variant="page" active={active} />;
}

/** Zwevend chatpaneel rechtsonder (overal beschikbaar, behalve op de chatpagina). */
export function TeamChatDock({ api, hidden, onExpand }: { api: TeamChatApi; hidden?: boolean; onExpand?: (conversationId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <div className="team-chat-dock-root">
      {open && (
        <section className="team-chat-dock" role="dialog" aria-label="Teamchat">
          <ChatShell
            api={api}
            variant="dock"
            active={open}
            onClose={() => setOpen(false)}
            onExpand={onExpand ? (id) => { setOpen(false); onExpand(id); } : undefined}
          />
        </section>
      )}
      <button type="button" className={`team-chat-fab${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Teamchat sluiten' : 'Teamchat openen'} aria-expanded={open}>
        {open ? <X size={22} /> : <MessageSquare size={22} />}
        {!open && api.unreadTotal > 0 && <span className="team-chat-fab-badge">{api.unreadTotal > 99 ? '99+' : api.unreadTotal}</span>}
      </button>
    </div>
  );
}
