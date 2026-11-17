// Verbindung zu deinem Supabase-Projekt (für die Synchronisation).
// Beides ist öffentlich und darf hier stehen – geschützt werden deine Daten
// durch die Anmeldung und die Zugriffsregeln (Row Level Security) in Supabase.
// Leer lassen = Daten werden in der App unter ☁ eingetragen.
window.SPIELE_CONFIG = {
  supabaseUrl: '',   // z. B. 'https://abcdefgh.supabase.co'
  supabaseKey: '',   // „Publishable key“ (sb_publishable_…) oder „anon public“ key
};
