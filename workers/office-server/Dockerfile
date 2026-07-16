# Collabora Online (CODE) voor Cloudflare Containers.
#
# Rol: puur de render-engine. De canonieke documenten blijven op Cloudflare R2;
# de media-api Worker is de WOPI-host die de bytes levert en terugschrijft.
#
# Cloudflare Containers draaien ZONDER extra Linux-capabilities en op een vluchtige
# overlay-filesystem. Collabora's chroot-jail verwacht normaal CAP_SYS_ADMIN/CAP_MKNOD
# + mount-namespaces; die zijn hier niet beschikbaar. `--o:mount_namespaces=false` is een
# POGING om zonder namespaces te draaien, maar of stock Collabora capability-loos boot op CF
# is ONBEWEZEN. >>> DIT is de #1 deploy-onzekerheid — zie OFFICE_EDITING_SETUP.md §7.1;
# faalt de boot op de jail, dan is Fly.io (met caps) de terugvaloptie. <<<
# NB: envVars in src/index.ts overschrijven deze ENV-defaults; pas dáár de jail-flag aan.
#
# Config wordt bij het opstarten uit de omgeving gelezen; die zetten we (makkelijker te
# wijzigen) via `envVars` in src/index.ts. De ENV-regels hieronder zijn image-defaults.
FROM collabora/code:latest

# WOPI-host(s) die Collabora mag benaderen (de media-api Worker). MOET overeenkomen met
# de host in de WOPISrc die media-api genereert. Wordt overschreven door envVars in de
# Container-class; hier alleen als vangnet-default.
ENV aliasgroup1="https://REPLACE-WITH-media-api-host"

# --o:ssl.enable=false + ssl.termination=true : CF-edge doet HTTPS.
# --o:mount_namespaces=false                  : jail zonder capabilities (zie boven).
# --o:net.frame_ancestors=...                 : sta inbedding in de ResoFly-app-iframe toe.
ENV extra_params="--o:ssl.enable=false --o:ssl.termination=true --o:mount_namespaces=false --o:net.frame_ancestors=https://app.resofly.nl https://staging.resofly.nl"

# coolwsd luistert op 9980 (HTTP + WebSocket). CF fronts exact deze poort via de DO.
EXPOSE 9980
