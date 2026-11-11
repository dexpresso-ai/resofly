-- ============================================================
-- ResoFly — "mcp-staging" is geen klantnaam
-- Date: 2026-11-11
--
-- De AI-koppeling van staging staat sinds vandaag op
-- https://mcp-staging.resofly.com/mcp (workers/mcp). Productie krijgt later
-- mcp.resofly.com; "mcp" stond al op de lijst met gereserveerde namen
-- (20261108230000), "mcp-staging" niet.
--
-- Zonder deze regel kon een organisatie mcp-staging.resofly.com als eigen adres
-- kiezen. De Worker-route voor dat adres gaat voor de klantadressen, dus het
-- klantportaal was daar nooit verschenen. De naam was dan wel van de klant
-- geweest, en het adres had tegelijk de koppelserver voor elke AI van staging
-- moeten zijn. Op staging had niemand de naam (gecontroleerd op 11 november).
--
-- Alleen de lijst groeit; de rest van client_subdomain_problem is gelijk aan
-- 20261108230000. Een bestaande rij met deze naam blijft bestaan: de
-- tabelcontrole kijkt bewust alleen naar de vorm (zie client_subdomains).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

create or replace function public.client_subdomain_problem(p_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := coalesce(p_name, '');
begin
  if length(v) < 3 then return 'te_kort'; end if;
  if length(v) > 40 then return 'te_lang'; end if;
  if v !~ '^[a-z0-9-]+$' then return 'tekens'; end if;
  if left(v, 1) = '-' or right(v, 1) = '-' or position('--' in v) > 0 then return 'streepje'; end if;
  if v ~ '^[0-9-]+$' then return 'alleen_cijfers'; end if;
  if v = any (array[
    'www', 'app', 'apps', 'api', 'admin', 'beheer', 'beheerder', 'staging', 'test', 'tests', 'demo', 'dev', 'develop',
    'development', 'prod', 'production', 'preview', 'beta', 'alpha', 'sandbox', 'localhost', 'mail', 'email', 'e-mail',
    'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ns3', 'dns', 'ftp', 'sftp', 'ssh', 'vpn', 'webmail', 'send',
    'bounce', 'reply', 'antwoord', 'inbound', 'caldav', 'carddav', 'media', 'cdn', 'static', 'assets', 'img', 'images',
    'files', 'download', 'downloads', 'upload', 'uploads', 'status', 'docs', 'help', 'support', 'hulp', 'blog', 'login',
    'inloggen', 'logout', 'auth', 'sso', 'oauth', 'account', 'accounts', 'register', 'signup', 'aanmelden', 'billing',
    'betalen', 'pay', 'payment', 'payments', 'factuur', 'facturen', 'invoice', 'invoices', 'offerte', 'offertes', 'quote',
    'portal', 'portaal', 'klant', 'klanten', 'klantportaal', 'domein', 'domeinen', 'dashboard', 'werkruimte', 'workspace',
    'gerrie', 'mcp', 'mcp-staging', 'office', 'collabora', 'wopi', 'voorbeeld', 'example', 'root', 'system', 'systeem',
    'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply', 'info', 'contact', 'privacy',
    'terms', 'legal', 'ing', 'sns', 'asn', 'regiobank', 'bunq', 'knab', 'triodos', 'mollie', 'ideal', 'stripe', 'adyen',
    'klarna', 'kvk', 'mijnoverheid', 'overheid', 'politie', 'postnl', 'dhl', 'microsoft', 'google', 'apple', 'outlook',
    'office365', 'gmail', 'icloud', 'whatsapp', 'facebook', 'instagram', 'zendflix'
  ]) then
    return 'gereserveerd';
  end if;
  if v ~ '(resofly|brandcore|rabobank|abnamro|abn-amro|belastingdienst|digid|paypal)' then
    return 'gereserveerd';
  end if;
  return null;
end;
$$;

revoke all on function public.client_subdomain_problem(text) from public, anon;
grant execute on function public.client_subdomain_problem(text) to authenticated, service_role;

commit;
