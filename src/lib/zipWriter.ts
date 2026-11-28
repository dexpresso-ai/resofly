// De zip-schrijver staat in supabase/functions/_shared/zipWriter.ts: de
// Word-export van pagina's (pageDocx.ts) draait ook in een edge function, en
// die kan niet bij src/. Zo is er één zip-schrijver voor de app en de server.
export * from '../../supabase/functions/_shared/zipWriter.ts';
