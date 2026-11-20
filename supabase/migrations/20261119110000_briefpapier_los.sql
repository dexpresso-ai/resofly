-- Briefpapier los: de kern van de werkruimte laadt de bedrijfsinstellingen
-- zonder het eigen briefpapier.
--
-- Waarom: company_settings.invoice_template_data_url is het briefpapier als
-- data-URL, op staging tot 286 KB per rij. De app laadde de rij met select *
-- bij elke start én na elke wijziging (refresh), terwijl alleen een PDF het
-- briefpapier nodig heeft. Op staging kostte die ene rij gemiddeld 92 ms in de
-- database, plus het downloaden.
--
-- Deze functie geeft de rij als JSON zonder dat ene veld. Met `to_jsonb(rij) -
-- veld` komt een kolom die later bijkomt vanzelf mee. Een vaste kolomlijst (of
-- een view, die * vastlegt bij het aanmaken) zou zo'n kolom stil weglaten, en
-- het instellingenformulier zou dan bij opslaan de standaardwaarde terugzetten.
--
-- security invoker: de RLS van company_settings geldt gewoon. Wie de rij niet
-- mag lezen, krijgt null. Het briefpapier zelf haalt de app op met een gewone
-- select van die ene kolom, pas als er een PDF gemaakt wordt.
--
-- Veilig om opnieuw te draaien (create or replace).

create or replace function public.company_settings_core(p_organization_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select to_jsonb(cs) - 'invoice_template_data_url'
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
$function$;

comment on function public.company_settings_core(uuid) is
  'De bedrijfsinstellingen zonder het briefpapier (invoice_template_data_url), voor de kern van de werkruimte. RLS van company_settings geldt (security invoker).';

revoke all on function public.company_settings_core(uuid) from public, anon;
grant execute on function public.company_settings_core(uuid) to authenticated, service_role;
