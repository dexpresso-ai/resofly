-- Recheck hardening: SQL delimiter, organization member visibility, immutable organization_id, ticket conversion RPC.

create or replace function public.prevent_organization_id_change()
returns trigger language plpgsql as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
end; $$;

drop trigger if exists clients_prevent_org_change on public.clients;
drop trigger if exists projects_prevent_org_change on public.projects;
drop trigger if exists tasks_prevent_org_change on public.tasks;
drop trigger if exists tickets_prevent_org_change on public.tickets;
drop trigger if exists notes_prevent_org_change on public.notes;
drop trigger if exists company_settings_prevent_org_change on public.company_settings;
drop trigger if exists quotes_prevent_org_change on public.quotes;
drop trigger if exists invoices_prevent_org_change on public.invoices;
drop trigger if exists attachments_prevent_org_change on public.attachments;
drop trigger if exists calendar_connections_prevent_org_change on public.calendar_connections;
drop trigger if exists calendar_connection_tokens_prevent_org_change on public.calendar_connection_tokens;
drop trigger if exists calendar_sources_prevent_org_change on public.calendar_sources;

create trigger clients_prevent_org_change before update of organization_id on public.clients for each row execute function public.prevent_organization_id_change();
create trigger projects_prevent_org_change before update of organization_id on public.projects for each row execute function public.prevent_organization_id_change();
create trigger tasks_prevent_org_change before update of organization_id on public.tasks for each row execute function public.prevent_organization_id_change();
create trigger tickets_prevent_org_change before update of organization_id on public.tickets for each row execute function public.prevent_organization_id_change();
create trigger notes_prevent_org_change before update of organization_id on public.notes for each row execute function public.prevent_organization_id_change();
create trigger company_settings_prevent_org_change before update of organization_id on public.company_settings for each row execute function public.prevent_organization_id_change();
create trigger quotes_prevent_org_change before update of organization_id on public.quotes for each row execute function public.prevent_organization_id_change();
create trigger invoices_prevent_org_change before update of organization_id on public.invoices for each row execute function public.prevent_organization_id_change();
create trigger attachments_prevent_org_change before update of organization_id on public.attachments for each row execute function public.prevent_organization_id_change();
create trigger calendar_connections_prevent_org_change before update of organization_id on public.calendar_connections for each row execute function public.prevent_organization_id_change();
create trigger calendar_connection_tokens_prevent_org_change before update of organization_id on public.calendar_connection_tokens for each row execute function public.prevent_organization_id_change();
create trigger calendar_sources_prevent_org_change before update of organization_id on public.calendar_sources for each row execute function public.prevent_organization_id_change();

drop policy if exists "members read by self or admins" on public.organization_members;
drop policy if exists "members read by org members" on public.organization_members;
create policy "members read by org members" on public.organization_members for select using (public.can_read_org(organization_id));

create or replace function public.convert_ticket_to_project(p_ticket_id uuid, p_organization_id uuid)
returns public.projects
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_project public.projects;
begin
  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
    and organization_id = p_organization_id
    and public.can_write_org(p_organization_id)
  for update;

  if not found then raise exception 'Ticket niet gevonden of geen toegang' using errcode = 'P0002'; end if;
  if v_ticket.status = 'converted' or v_ticket.converted_to_project_id is not null then raise exception 'Ticket is al omgezet' using errcode = 'P0001'; end if;
  if v_ticket.status not in ('new','review','approved') then raise exception 'Ticketstatus % kan niet worden omgezet naar een project', v_ticket.status using errcode = 'P0001'; end if;

  insert into public.projects (organization_id, created_by, client_id, name, description, color, archived)
  values (
    v_ticket.organization_id,
    auth.uid(),
    v_ticket.client_id,
    v_ticket.title,
    v_ticket.description,
    case when v_ticket.priority = 'high' then '#f06b6b' else '#FFD966' end,
    false
  ) returning * into v_project;

  update public.tickets
  set status = 'converted', converted_to_project_id = v_project.id, updated_at = now()
  where id = p_ticket_id
    and organization_id = p_organization_id;

  return v_project;
end;
$$;
