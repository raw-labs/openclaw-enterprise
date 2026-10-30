# Edit Gateway outbound hosts

Open **Pages/Agent detail → Gateway outbound hosts**. These previews use real
Console controls and simulated API responses. They do not prove deployment,
network enforcement, persistence or permissions.

1. Read the additional host list. Enabled Channels supply their own required
   destinations; this editor does not change native Configuration.
2. Add `service.example.com` on a new line. Save outbound hosts. Read the saved
   message, then reload to confirm the list. Deploy a new version to apply it.
3. Clear the field and save. The empty state says that no additional hosts are
   approved; this does not remove Channel requirements.
4. Enter a URL or wildcard and save. Correct the field error before retrying.

Review **Gateway outbound hosts, empty**, **administer denied**, **checking
permissions**, **saving**, **save refused**, and **outcome unknown**. A pending
save blocks edits and navigation. A refused save retains the entered hosts. An
uncertain result requires readback instead of another write. Both `update` and
`administer` on the exact Agent are required; Agent update alone is insufficient.
Embedded Agents have no outbound editor. Missing model credentials do not grant
additional hosts or prevent an otherwise authorized destination edit.

Capture desktop and phone screenshots and a short add/save/clear walkthrough
outside the checkout. Record the source revision and asset fingerprint. Upload
the images and video for review; do not present Storybook as backend proof.
