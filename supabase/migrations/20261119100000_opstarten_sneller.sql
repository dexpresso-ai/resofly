-- Opstarten sneller: het dashboard telt de banktransacties die nog gekoppeld
-- moeten worden zonder de RLS per rij.
--
-- Waarom: de app vroeg dit aantal bij elke start en elke ververs op met
-- select count(*) op bank_transactions. De RLS op die tabel roept per rij twee
-- rechtenfuncties aan (user_is_org_member en org_module_level, allebei een
-- eigen query op organization_members). Op staging kostte de telling zo
-- gemiddeld 410 ms (max 1,3 s) bij 3.620 rijen; met EXPLAIN ANALYZE 166 ms
-- voor 1.820 rijen, tegen 1,6 ms zonder de controle per rij. De kern van de
-- werkruimte wacht op zijn traagste vraag, dus het laadscherm ook.
--
-- Deze functie controleert de rechten één keer, met dezelfde regels als de
-- RLS (lezen in de organisatie én de module Financiën), en telt daarna via de
-- index (organization_id, status). Zonder leesrecht geeft hij 0, net als de
-- telling via de RLS deed: een teamlid zonder Financiën ziet geen aantal en
-- krijgt geen fout.
--
-- Veilig om opnieuw te draaien (create or replace).

create or replace function public.bank_transactions_to_reconcile(p_organization_id uuid)
returns integer
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    return 0;
  end if;
  return (
    select count(*)::integer
    from public.bank_transactions bt
    where bt.organization_id = p_organization_id
      and bt.status in ('unmatched', 'suggested')
  );
end;
$function$;

comment on function public.bank_transactions_to_reconcile(uuid) is
  'Aantal banktransacties dat nog gekoppeld moet worden (unmatched + suggested), voor het dashboard. Controleert de rechten één keer in plaats van per rij.';

revoke all on function public.bank_transactions_to_reconcile(uuid) from public, anon;
grant execute on function public.bank_transactions_to_reconcile(uuid) to authenticated, service_role;
