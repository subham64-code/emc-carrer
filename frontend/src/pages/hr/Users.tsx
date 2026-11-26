import { useEffect, useState, type FormEvent } from "react";
import { Eye, Mail, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { hrApi } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import PageHeading from "../../components/ref/PageHeading";
import Button from "../../components/ref/Button";
import Modal from "../../components/ref/Modal";
import { Input } from "../../components/ref/Input";
import StatusPill from "../../components/ref/StatusPill";

export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [detailUser, setDetailUser] = useState<any | null>(null);
  const [form, setForm] = useState<{ name: string; email: string; roleId: string; departmentIds: string[] }>({ name: "", email: "", roleId: "", departmentIds: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [setupLink, setSetupLink] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canManage = (user?.permissions || []).includes("users.manage");
  const isSuperAdmin = (user?.roles ?? []).includes("SUPER_ADMIN");

  const load = () => {
    hrApi
      .users({ page: 1, pageSize: 100 })
      .then((r: any) => setUsers(r.data.items ?? r.data))
      .catch(() => setUsers([]));
  };

  useEffect(() => {
    Promise.all([
      hrApi.users({ page: 1, pageSize: 100 }).then((r: any) => setUsers(r.data.items ?? r.data)).catch(() => setUsers([])),
      hrApi.roles().then((r: any) => setRoles(r.data.roles ?? r.data)).catch(() => setRoles([])),
      hrApi.departmentDropdown().then((r: any) => setDepartments(r.data.items ?? r.data)).catch(() => setDepartments([])),
    ]).finally(() => setLoading(false));
  }, []);

  const assignableRoles = roles.filter((role: any) => ["HR_ADMIN", "HR_RECRUITER"].includes(role.key));
  const roleHint = (key: string) =>
    key === "HR_ADMIN"
      ? "Full HR access — everywhere except account reset and the audit log."
      : "Recruitment workspace: applications, screening, interviews, offers, databank and reports.";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.roleId) {
      setError("Choose a role: HR Admin or Sub HR.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await hrApi.createUser({
        name: form.name,
        email: form.email,
        roleIds: [form.roleId],
        departmentIds: form.departmentIds,
        baseUrl: window.location.origin,
      });
      setShowCreate(false);
      setForm({ name: "", email: "", roleId: "", departmentIds: [] });
      setSetupLink(result.data?.enrollmentLink || "");
      if (result.data?.emailDelivered === false) {
        setError("Account created, but the email was not delivered. Copy the setup link below and send it to the user.");
      } else {
        setMessage(`Account created for ${form.email}. An authenticator setup link has been emailed to them.`);
      }
      load();
    } catch (err: any) {
      setError(err.response?.data?.error?.message || "Could not invite the user.");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item: any) => {
    setError("");
    try {
      await (item.isActive ? hrApi.deactivateUser(item.id) : hrApi.activateUser(item.id));
      setUsers(users.map((x) => (x.id === item.id ? { ...x, isActive: !item.isActive } : x)));
      setMessage(`${item.name} ${item.isActive ? "deactivated" : "activated"}.`);
    } catch (err: any) {
      setError(err.response?.data?.error?.message || "Update failed.");
    }
  };

  const deleteUser = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await hrApi.deleteUser(deleteTarget.id);
      setUsers((current) => current.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
      setMessage(`${deleteTarget.name} was deleted.`);
    } catch (err: any) {
      setError(err.response?.data?.error?.message || "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  const totpLabel = (item: any) => {
    if (item.totpEnabled) return `Active${item.totpEnabledAt ? ` · ${new Date(item.totpEnabledAt).toLocaleDateString()}` : ""}`;
    if (item.totpEnrollmentPending) return "Setup pending";
    return "Not enrolled";
  };



  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase();

  return (
    <div>
      <PageHeading
        title="HR Team"
        description="View HR team members and registered team accounts."
        action={
          canManage ? (
            <Button icon={UserPlus} onClick={() => setShowCreate(true)}>
              Add HR user
            </Button>
          ) : undefined
        }
      />

      <div className="callout callout--info">
        <ShieldCheck size={18} />
        <div>
          <strong>Team access</strong>
          <span>Manage HR team members and their account access.</span>
        </div>
      </div>

      {(error || message) && (
        <div className={`notice ${error ? "notice--error" : "notice--success"}`} role="status">
          <div className="notice__body">
            <div className="notice__title">{error || message}</div>
          </div>
        </div>
      )}

      {setupLink && (
        <div className="notice notice--info" role="status">
          <div className="notice__body">
            <div className="notice__title">One-time authenticator setup link</div>
            <p className="text-[11px] ink-soft mt-1">Valid 10 minutes, usable once. Send this to the HR user if they did not receive the email.</p>
            <div className="flex flex-col sm:flex-row gap-2 mt-2">
              <input readOnly value={setupLink} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-[11px] font-mono ink-body" />
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(setupLink); }} className="rounded-lg border border-[var(--border-strong)] bg-white px-3 py-2 text-xs font-semibold ink-body hover:bg-gray-50">Copy link</button>
              <a href={setupLink} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--border-strong)] bg-white px-3 py-2 text-xs font-semibold ink-body hover:bg-gray-50 text-center">Open</a>
            </div>
            <button type="button" onClick={() => setSetupLink("")} className="text-xs ink-soft hover:underline mt-2">Dismiss</button>
          </div>
        </div>
      )}

      <section className="card">
        <div className="card__header">
          <div>
            <h2 className="card__title">Registered team</h2>
            <p className="card__subtitle">{users.length} team members</p>
          </div>
        </div>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th style={{ textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((item: any) => (
                <tr key={item.id}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <span className="avatar avatar--sm">{initials(item.name || item.email || "HR")}</span>
                      <div>
                        <strong>{item.name}</strong>
                        <span className="table-muted">{item.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {(item.roles ?? []).map((role: any) => (
                        <span key={role.role?.id || role.role?.key} className="badge badge--grey">
                          {role.role?.name || role.role?.key}
                        </span>
                      ))}
                      {(item.roles ?? []).length === 0 && <span className="table-muted">-</span>}
                    </div>
                  </td>
                  <td><StatusPill status={item.isActive ? "ACTIVE" : "INACTIVE"} /></td>
                  <td style={{ textAlign: "center" }}>
                    <div className="flex gap-2" style={{ justifyContent: "center" }}>
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => setDetailUser(item)}><Eye size={14} /> View</button>
                      {isSuperAdmin && <Button variant="danger" size="sm" icon={Trash2} onClick={() => setDeleteTarget(item)}>Delete</Button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && users.length === 0 && (
                <tr><td colSpan={4}><div className="empty-state">No team members yet.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add HR user"
        subtitle="Creates the account and emails a single-use authenticator setup link."
        size="lg"
        footer={<><Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button><Button icon={Mail} type="submit" form="add-hr-form" loading={saving}>Create &amp; send invitation</Button></>}
      >
        <form id="add-hr-form" onSubmit={submit} className="form-grid">
          <Input
            label="Full name"
            required
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
          <Input
            label="Work email"
            type="email"
            required
            value={form.email}
            onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
          />
          <div className="field field--full">
            <span className="field__label">Role <span className="text-red-500">*</span></span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {assignableRoles.map((role: any) => {
                const selected = form.roleId === role.id;
                return (
                  <label
                    key={role.id}
                    className={`flex flex-col gap-1 p-3 rounded-xl border cursor-pointer transition-colors ${
                      selected ? "border-[#659616] bg-[#659616]/[0.06] ring-2 ring-[#659616]/40" : "border-[#171717]/10 hover:bg-[#171717]/[0.03]"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="hr-role"
                        className="w-4 h-4 accent-[#659616]"
                        checked={selected}
                        onChange={() => setForm((current) => ({ ...current, roleId: role.id }))}
                      />
                      <span className="text-sm font-semibold ink-body">{role.name}</span>
                    </span>
                    <span className="text-[11px] ink-soft leading-snug pl-6">{roleHint(role.key)}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="field field--full">
            <span className="field__label">
              Department access
              <span className="field__optional"> — leave everything unchecked for access to all departments</span>
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-52 overflow-y-auto pr-1">
              {departments.map((department: any) => {
                const checked = form.departmentIds.includes(department.id);
                return (
                  <label
                    key={department.id}
                    className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                      checked ? "border-[#659616] bg-[#659616]/[0.06]" : "border-[#171717]/10 hover:bg-[#171717]/[0.03]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-[#659616]"
                      checked={checked}
                      onChange={() =>
                        setForm((current) => ({
                          ...current,
                          departmentIds: checked ? current.departmentIds.filter((id) => id !== department.id) : [...current.departmentIds, department.id],
                        }))
                      }
                    />
                    <span className="text-xs ink-body leading-tight">{department.name}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-[11px] ink-soft mt-1.5">{form.departmentIds.length === 0 ? "Access to all departments" : `Access limited to ${form.departmentIds.length} department${form.departmentIds.length === 1 ? "" : "s"}`}</p>
          </div>
        </form>
      </Modal>
      <Modal open={!!detailUser} onClose={() => setDetailUser(null)} title={detailUser?.name || "Team member"} subtitle={detailUser?.email || ""} size="md">
        {detailUser && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs ink-soft">Status</p><StatusPill status={detailUser.isActive ? "ACTIVE" : "INACTIVE"} /></div>
              <div><p className="text-xs ink-soft">Authenticator</p><p className="font-medium ink-body">{totpLabel(detailUser)}</p></div>
              <div><p className="text-xs ink-soft">Last login</p><p className="font-medium ink-body">{detailUser.lastLoginAt ? new Date(detailUser.lastLoginAt).toLocaleString() : "Never signed in"}</p></div>
              <div><p className="text-xs ink-soft">Departments</p><p className="font-medium ink-body">{(detailUser.departments ?? []).map((d:any)=>d.name).join(", ") || "All"}</p></div>
            </div>
            <div><p className="text-xs ink-soft mb-1">Roles</p><div className="flex flex-wrap gap-1">{(detailUser.roles ?? []).map((r:any)=><span key={r.role?.id||r.role?.key} className="badge badge--grey">{r.role?.name||r.role?.key}</span>)}</div></div>
            {canManage && (
              <div className="flex gap-2 pt-2 border-t" style={{borderColor:"var(--border)"}}>
                <button type="button" className="btn btn--outline btn--sm" onClick={() => { toggleActive(detailUser); setDetailUser({...detailUser, isActive: !detailUser.isActive}); }}>{detailUser.isActive ? "Deactivate" : "Activate"}</button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => (deleting ? undefined : setDeleteTarget(null))}
        title="Delete HR team member?"
        subtitle={deleteTarget ? `${deleteTarget.name} (${deleteTarget.email})` : ""}
        size="md"
        footer={<><Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Keep</Button><Button variant="danger" onClick={deleteUser} loading={deleting}>Delete HR member</Button></>}
      >
        <p className="text-sm ink-body">
          Deleting an HR team member permanently removes the account. The member will no longer be able to sign in; this action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
