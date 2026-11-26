  import { Link, useNavigate } from "react-router-dom";

import {

  Activity,

  BriefcaseBusiness,

  CalendarClock,

  ClipboardList,

  FileText,

  MailQuestion,

  RefreshCw,

  ShieldCheck,

  Sparkles,

  UsersRound,

} from "lucide-react";

import { useMemo, useState } from "react";

import { hrApi } from "../../lib/api";

import { useAuth } from "../../context/AuthContext";

import { canAccess, SECTION_PERMISSIONS } from "../../lib/sectionPermissions";

import Button from "../../components/ref/Button";

import EmptyState from "../../components/ref/EmptyState";

import { useApiQuery, queryKeys, useInvalidate } from "../../hooks/useApiQuery";



function timeGreeting() {

  const hour = new Date().getHours();

  if (hour < 12) return "Good Morning";

  if (hour < 17) return "Good Afternoon";

  return "Good Evening";

}



export default function HrWorkspaceDashboard() {

  const navigate = useNavigate();

  const { user } = useAuth();

  const invalidate = useInvalidate();

  const can = (permission?: string) => canAccess(user, permission);

  const [barChartZoom, setBarChartZoom] = useState(1);




  const { data: overview } = useApiQuery<any>(queryKeys.dashboardOverview, () => hrApi.dashboardOverview());

  const { data: departments = [] } = useApiQuery<any[]>(

    queryKeys.dashboardDepartments,

    () => hrApi.dashboardDepartments().then((response: any) => response?.data?.data?.departments ?? response?.data?.departments ?? []),

  );

  const { data: openings = [] } = useApiQuery<any[]>(

    ["dashboard", "openings"],

    () => hrApi.openings({ page: 1, pageSize: 8 }).then((response: any) => response?.data?.items ?? []),

    { enabled: can(SECTION_PERMISSIONS.openings) },

  );

  const { data: applications = [] } = useApiQuery<any[]>(

    ["dashboard", "applications"],

    () => hrApi.applications({ page: 1, pageSize: 50 }).then((response: any) => response?.data?.items ?? []),

    { enabled: can(SECTION_PERMISSIONS.submissions) },

  );

  const { data: auditLogs = [] } = useApiQuery<any[]>(

    ["dashboard", "activity"],

    () => hrApi.auditLogs({ page: 1, pageSize: 6 }).then((response: any) => response?.data?.items ?? response?.data?.logs ?? []),

    { enabled: can(SECTION_PERMISSIONS.audit) },

  );



  const displayName = /^emc[\s-]+hr[\s-]+administrator$/i.test((user?.name || "").trim()) ? "HR Department" : user?.name || "HR Department";



  const stats = overview ?? {};

  const tasks = useMemo(() => {

    const items = [

      { title: "New applications to review", description: `${Number(stats.newApplications ?? 0)} candidate(s) are waiting for first review`, to: "/hr/submissions", count: Number(stats.newApplications ?? 0), tone: "blue", permission: SECTION_PERMISSIONS.submissions },

      { title: "Candidates under screening", description: `${Number(stats.underScreening ?? 0)} application(s) need CV screening and HR actions`, to: "/hr/ai-screening", count: Number(stats.underScreening ?? 0), tone: "orange", permission: SECTION_PERMISSIONS.ai },

      { title: "Admin approvals pending", description: `${Number(stats.pendingApprovals ?? 0)} selected candidate(s) require your authorisation`, to: "/hr/approvals", count: Number(stats.pendingApprovals ?? 0), tone: "red", permission: SECTION_PERMISSIONS.submissions },

      { title: "Offers pending response", description: `${Number(stats.offersAwaitingResponse ?? stats.pendingOffers ?? 0)} offer(s) are waiting for acceptance/rejection`, to: "/hr/offers", count: Number(stats.offersAwaitingResponse ?? stats.pendingOffers ?? 0), tone: "orange", permission: SECTION_PERMISSIONS.offers },

      { title: "Documents to verify", description: `${Number(stats.documentsAwaitingVerification ?? 0)} document(s) uploaded and awaiting HR review`, to: "/hr/onboarding", count: Number(stats.documentsAwaitingVerification ?? 0), tone: "blue", permission: SECTION_PERMISSIONS.onboarding },

      { title: "Joinings in progress", description: `${Number(stats.joiningPending ?? 0)} accepted candidate(s) are still completing onboarding`, to: "/hr/onboarding", count: Number(stats.joiningPending ?? 0), tone: "orange", permission: SECTION_PERMISSIONS.onboarding },

    ];

    return items.filter((item) => canAccess(user, item.permission)).sort((left, right) => right.count - left.count);

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [stats, user]);



  const metrics = [

    { label: "Total employees", value: Number(stats.totalEmployees ?? 0).toLocaleString(), detail: `${Number(stats.existingEmployees ?? 0)} current - ${Number(stats.formerEmployees ?? 0)} former`, icon: UsersRound, to: "/hr/employees?tab=current", tone: "green", permission: SECTION_PERMISSIONS.employees },

    { label: "Open positions", value: Number(stats.activeJobOpenings ?? 0), detail: `${Number(stats.closedJobOpenings ?? 0)} closed roles`, icon: BriefcaseBusiness, to: "/hr/manage-openings", tone: "orange", permission: SECTION_PERMISSIONS.openings },

    { label: "Total applications", value: Number(stats.totalApplications ?? 0).toLocaleString(), detail: `${Number(stats.shortlistedCandidates ?? 0)} already shortlisted`, icon: ClipboardList, to: "/hr/submissions", tone: "green", permission: SECTION_PERMISSIONS.submissions },

    { label: "Invitations pending", value: Number(stats.pendingInvitations ?? 0), detail: `${Number(stats.pendingSubmissions ?? 0)} submissions awaiting validation`, icon: MailQuestion, to: "/hr/employees?tab=invitations", tone: "orange", permission: SECTION_PERMISSIONS.employees },

    { label: "Upcoming interviews", value: Number(stats.upcomingInterviews ?? 0), detail: `${Number(stats.upcomingInterviews ?? 0)} scheduled/rescheduled`, icon: CalendarClock, to: "/hr/interviews", tone: "green", permission: SECTION_PERMISSIONS.interviews },

    { label: "Selected for offers", value: Number(stats.selectedCandidates ?? 0), detail: `${Number(stats.employeesHandedOver ?? 0)} handed over`, icon: ShieldCheck, to: "/hr/approvals", tone: "orange", permission: SECTION_PERMISSIONS.submissions },

  ].filter((metric) => canAccess(user, metric.permission));



  const recentApplications = useMemo(() => [...applications]

    .sort((left: any, right: any) => new Date(right.appliedAt ?? right.createdAt ?? 0).getTime() - new Date(left.appliedAt ?? left.createdAt ?? 0).getTime())

    .slice(0, 6), [applications]);



  const refreshWorkspace = () => invalidate(["dashboard", "departments", "openings", "applications", "email-logs", "audit-logs", "offers", "documents", "onboarding", "interviews"]);



  return (

    <div className="page">

      <div className="page-heading">

        <div>

          <h1 className="page-heading__title">{timeGreeting()}, {displayName}</h1>

          <p className="page-heading__subtitle">Every metric, pending action and team status updates live from the cloud database.</p>

        </div>

        <div className="page-heading__actions"><Button variant="outline" icon={RefreshCw} onClick={refreshWorkspace}>Refresh live data</Button>{can(SECTION_PERMISSIONS.reports) && <Link className="btn btn--primary" to="/hr/reports"><Activity size={16} /> Live reports</Link>}</div>

      </div>



      <div className="hr-metric-grid hr-metric-grid--six">

        {metrics.map((metric) => {

          const Icon = metric.icon;

          return (

            <button type="button" key={metric.label} className={`hr-metric hr-metric--${metric.tone} hr-metric--button`} onClick={() => navigate(metric.to)} aria-label={`Open ${metric.label}`}>

              <span><span className="hr-metric__label">{metric.label}</span><strong className="hr-metric__value">{metric.value}</strong><span className="hr-metric__detail">{metric.detail}</span></span>

              <span className="hr-metric__icon"><Icon size={22} /></span>

            </button>

          );

        })}

      </div>



      <div className="hr-dashboard-grid hr-dashboard-grid--workspace">

        <section className="card">

          <div className="card__header"><div><h2 className="card__title">Today&apos;s operating agenda</h2><p className="card__subtitle">Ranked by everything still waiting for HR.</p></div></div>

          <div className="operational-agenda">

            {tasks.length === 0 && <EmptyState icon={ClipboardList} title="Nothing waiting for you" description="There are no pending items you can act on." />}

            {tasks.map((task, index) => (

              <Link to={task.to} key={task.title} className={`operational-agenda__item operational-agenda__item--${task.tone}`}>

                <span className="operational-agenda__index">{String(index + 1).padStart(2, "0")}</span>

                <span className="operational-agenda__body">

                  <strong>{task.title}</strong>

                  <small>{task.description}</small>

                </span>

                <span className="operational-agenda__count">{task.count}</span>

              </Link>

            ))}

          </div>

        </section>



        {can(SECTION_PERMISSIONS.submissions) && (

          <section className="card">

            <div className="card__header"><div><h2 className="card__title">Recent applications</h2><p className="card__subtitle">Newest candidates HR needs to review first.</p></div><Link className="text-link" to="/hr/submissions">View all</Link></div>

          <div className="compact-list">

            {recentApplications.length === 0 ? <EmptyState icon={ClipboardList} title="No applications yet" description="Candidate applications will appear here as soon as they are received." /> : recentApplications.map((application: any) => (

              <Link className="compact-list__item" key={application.id} to={`/hr/submissions?search=${encodeURIComponent(application.applicationCode)}`}>

                <span className="compact-list__icon"><FileText size={16} /></span>

                <div><strong>{application.candidate?.fullName ?? "Candidate"}</strong><span>{application.jobOpening?.title ?? "Position"} - {application.applicationCode}</span></div>

                <span className="badge badge--blue">{String(application.status || "").replace(/_/g, " ")}</span>

              </Link>

            ))}

          </div>

          </section>

        )}

      </div>



      <div className="hr-dashboard-grid hr-dashboard-grid--workspace">

        {can(SECTION_PERMISSIONS.openings) && (

          <section className="card">

            <div className="card__header"><div><h2 className="card__title">Recent openings</h2><p className="card__subtitle">Live opening register - click any role to manage it.</p></div><Link className="text-link" to="/hr/manage-openings">Manage</Link></div>

          <div className="compact-list">

            {openings.slice(0, 5).map((opening: any) => (

              <Link className="compact-list__item" key={opening.id} to="/hr/manage-openings">

                <span className="compact-list__icon"><BriefcaseBusiness size={16} /></span>

                <div><strong>{opening.title}</strong><span>{opening.department?.name ?? "-"}{opening.location ? ` - ${opening.location}` : ""}</span></div>

                <span className="status-pill">{String(opening.status ?? "").toLowerCase()}</span>

              </Link>

            ))}

            {openings.length === 0 && <EmptyState icon={BriefcaseBusiness} title="No openings yet" description="Create your first published opening to activate the hiring workflow." />}

          </div>

          </section>

        )}



        {can(SECTION_PERMISSIONS.audit) && (

          <section className="card">

            <div className="card__header"><div><h2 className="card__title">Recent system activity</h2><p className="card__subtitle">Actions written to the HR audit trail.</p></div>{can(SECTION_PERMISSIONS.settings) && <Link className="text-link" to="/hr/settings">Settings</Link>}</div>

            <div className="compact-list">

              {auditLogs.slice(0, 5).map((entry: any, index: number) => (

                <div className="compact-list__item" key={`${entry.id}-${index}`}>

                  <span className="compact-list__icon"><Sparkles size={15} /></span>

                  <div><strong>{String(entry.action || "HR activity").replace(/_/g, " ")}</strong><span>{entry.actorEmail ?? entry.actorId ?? "System"} - {entry.createdAt ? new Date(entry.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</span></div>

                </div>

              ))}

              {auditLogs.length === 0 && <EmptyState icon={Activity} title="No activity yet" description="Workflow events will appear here automatically." />}

            </div>

          </section>

        )}

      </div>



      <section className="card pipeline-card">
        <div className="card__header"><div><h2 className="card__title">Department-wise hiring pipeline</h2><p className="card__subtitle">Scrollable department pipeline overview.</p></div>{can(SECTION_PERMISSIONS.reports) && <Link className="text-link" to="/hr/reports">Open reports</Link>}</div>
        <div className="table-wrapper" style={{ maxHeight: 320, overflowY: "auto" }}>
          <table className="data-table pipeline-table">
            <thead><tr><th>Department</th><th>Employees</th><th>Open roles</th><th>Applications</th><th>Screened</th><th>Interviews</th><th>Hired</th><th>Progress</th></tr></thead>
            <tbody>
              {departments.map((department: any) => {
                const applicationsTotal = Number(department.totalApplicants ?? 0);
                const hired = Number(department.hired ?? 0);
                const percentage = applicationsTotal ? Math.min(100, Math.round((hired / applicationsTotal) * 100)) : 0;
                return (
                  <tr key={department.id}>
                    <td><strong>{department.name}</strong></td>
                    <td>{Number(department.totalEmployees ?? 0)}</td>
                    <td>{Number(department.activeOpenings ?? 0)}</td>
                    <td>{applicationsTotal}</td>
                    <td>{Number(department.screened ?? 0)}</td>
                    <td>{Number(department.interviews ?? 0)}</td>
                    <td>{hired}</td>
                    <td>{can(SECTION_PERMISSIONS.reports)
                      ? <Link className="pipeline-progress" to="/hr/reports" aria-label={`Open ${department.name} report`}><span style={{ width: `${percentage}%` }} /></Link>
                      : <div className="pipeline-progress pipeline-progress--static"><span style={{ width: `${percentage}%` }} /></div>}</td>
                  </tr>
                );
              })}
              {departments.length === 0 && <tr><td colSpan={8}><div className="empty-state">No department pipeline data yet.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="hr-dashboard-grid hr-dashboard-grid--workspace">
        <section className="card">
          <div className="card__header"><div><h2 className="card__title">Employees per department</h2></div><div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}><button type="button" onClick={() => setBarChartZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", color: "var(--ink)", fontWeight: 700, cursor: "pointer" }}>-</button><span style={{ fontSize: 12, color: "var(--muted)" }}>{Math.round(barChartZoom * 100)}%</span><button type="button" onClick={() => setBarChartZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card)", color: "var(--ink)", fontWeight: 700, cursor: "pointer" }}>+</button></div></div>
          <div className="card__body">
            {(() => {
              const rows = (departments as any[]).map((d) => ({ name: String(d.name || "Unspecified"), value: Number(d.totalEmployees ?? 0) })).filter((d) => d.name);
              const max = Math.max(1, ...rows.map((r) => r.value));
              const H = 320, PL = 42, PR = 20, PT = 20, PB = 100;
              const innerH = H - PT - PB;
              const chartW = Math.max(560, PL + PR + rows.length * 56);
              const slot = (chartW - PL - PR) / Math.max(1, rows.length);
              const barW = Math.max(18, Math.min(40, slot - 16));
              return (
                <div style={{ overflowX: "auto" }}>
                  <svg viewBox={`0 0 ${chartW} ${H}`} style={{ width: `calc(100% * ${barChartZoom})`, minWidth: Math.max(320, chartW * barChartZoom), height: H }}>
                    {[0, 1, 2, 3, 4].map((i) => { const y = PT + (i * innerH) / 4; const v = Math.round(max - (i * max) / 4); return <g key={i}><line x1={PL} x2={chartW - PR} y1={y} y2={y} stroke="var(--border)" /><text x={PL - 8} y={y + 4} textAnchor="end" fontSize="10" fontWeight="700" fill="var(--muted)">{v}</text></g>; })}
                    <line x1={PL} y1={PT} x2={PL} y2={H - PB} stroke="var(--muted)" strokeWidth="1.5" />
                    <line x1={PL} y1={H - PB} x2={chartW - PR} y2={H - PB} stroke="var(--muted)" strokeWidth="1.5" />
                    {rows.map((r, i) => { const x = PL + i * slot + (slot - barW) / 2; const h = Math.max(2, (r.value / max) * innerH); const y = H - PB - h; const lx = x + barW / 2; const ly = H - PB + 10; return <g key={r.name + i}><rect x={x} y={y} width={barW} height={h} fill="#7ab41b" rx="4" />{r.value > 0 && <text x={lx} y={y - 6} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--ink)">{r.value}</text>}<text x={lx} y={ly} textAnchor="end" fontSize="10" fontWeight="700" fill="var(--muted)" transform={`rotate(-90 ${lx} ${ly})`}>{r.name}</text></g>; })}
                    {rows.length === 0 && <text x={chartW / 2} y={H / 2} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--muted)">No department data</text>}
                  </svg>
                </div>
              );
            })()}
          </div>
        </section>

        <section className="card">
          <div className="card__header"><div><h2 className="card__title">Former employees per department</h2><p className="card__subtitle">Departments with 0 former employees are hidden.</p></div></div>
          <div className="card__body">
            {(() => {
              const rows = (departments as any[]).map((d) => ({ name: String(d.name || "Unspecified"), value: Number(d.formerEmployees ?? d.leftEmployees ?? d.resigned ?? 0) })).filter((d) => d.value > 0);
              const total = rows.reduce((s, r) => s + r.value, 0);
              const colors = ["#7ab41b", "#ff9412", "#ffb03a", "#9bcf4b", "#d97706", "#4b5563", "#84cc16", "#f59e0b"];
              let offset = 0;
              const stops = rows.map((r, i) => { const start = (offset / Math.max(1, total)) * 360; offset += r.value; const end = (offset / Math.max(1, total)) * 360; return `${colors[i % colors.length]} ${start}deg ${end}deg`; }).join(", ");
              return rows.length ? (
                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ width: 180, height: 180, borderRadius: "50%", background: `conic-gradient(${stops})`, position: "relative", flexShrink: 0 }}>
                    <div style={{ position: "absolute", inset: 30, background: "var(--card)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}><strong style={{ fontSize: 20, color: "var(--ink)" }}>{total}</strong><span style={{ fontSize: 11, color: "var(--muted)" }}>Former</span></div>
                  </div>
                  <div style={{ flex: 1, minWidth: 180, display: "grid", gap: 8 }}>
                    {rows.map((r, i) => { const pct = total ? ((r.value / total) * 100).toFixed(1) : "0.0"; return <div key={r.name + i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: colors[i % colors.length] }} /><span style={{ flex: 1, color: "var(--ink-soft)" }}>{r.name}</span><strong style={{ color: "var(--ink)" }}>{pct}%</strong><span style={{ color: "var(--muted)" }}>({r.value})</span></div>; })}
                  </div>
                </div>
              ) : <div className="empty-state">No former employees to display.</div>;
            })()}
          </div>
        </section>
      </div>

    </div>
  );
}
