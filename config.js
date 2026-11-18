// Verbindung zu deinem Supabase-Projekt (für die Synchronisation).
// Beides ist öffentlich und darf hier stehen – geschützt werden deine Daten
// durch die Anmeldung und die Zugriffsregeln (Row Level Security) in Supabase.
window.SPIELE_CONFIG = {
  supabaseUrl: 'https://hxstggbkslefostpxylx.supabase.co',
  supabaseKey: 'sb_publishable_go8VuTL91IRl12sEar1jfw_ZM7-S4d-',
  // Name der Steam-Funktion so, wie er am Ende ihrer Adresse steht:
  // https://…supabase.co/functions/v1/rapid-task  →  'rapid-task'
  steamFunktion: 'rapid-task',
};
