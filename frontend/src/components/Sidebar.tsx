import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Building2,
  Briefcase,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Database,
  ExternalLink,
  FileText,
  LayoutDashboard,
  LogOut,
  Mail,
  PauseCircle,
  Send,
  Settings,
  ShieldCheck,
  UserCheck,
  UserMinus,
  UsersRound,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { SECTION_PERMISSIONS, canAccess, isController } from "../lib/sectionPermissions";
import { prefetchRoute } from "../lib/routePrefetch";

interface NavItem {
  label: string;
  to: string;
  icon: any;
  permission?: string | string[];
  controllerOnly?: boolean;
  match?: (pathname: string, search: string) => boolean;
}

interface NavGroup {
  key: string;
  label: string;
  icon: any;
  items: NavItem[];
}

const onPath = (prefix: string) => (pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const employeeTab = (tab: string) => (pathname: string, search: string) => {
  if (pathname.startsWith("/hr/employees/")) return false;
  const current = new URLSearchParams(search).get("tab");
  if (tab === "all") return pathname === "/hr/employees" && (!current || current.toLowerCase() === "all");
  return pathname === "/hr/employees" && current?.toLowerCase() === tab;
};

const GROUPS: NavGroup[] = [
  {
    key: "workspace",
    label: "HR Workspace",
    icon: LayoutDashboard,
    items: [
      { label: "Dashboard", to: "/hr/dashboard", icon: LayoutDashboard, permission: SECTION_PERMISSIONS.dashboard, match: onPath("/hr/dashboard") },
      { label: "Manage Opening", to: "/hr/manage-openings", icon: ExternalLink, permission: SECTION_PERMISSIONS.openings, match: (pathname) => onPath("/hr/manage-openings")(pathname) || onPath("/hr/openings")(pathname) },
      { label: "HR Team", to: "/hr/team", icon: UsersRound, controllerOnly: true, match: onPath("/hr/team") },
      { label: "Permissions", to: "/hr/permissions", icon: ShieldCheck, controllerOnly: true, match: onPath("/hr/permissions") },
    ],
  },
  {
    key: "databank",
    label: "Employee Databank",
    icon: Database,
    items: [
      { label: "All Employees", to: "/hr/employees", icon: UsersRound, permission: SECTION_PERMISSIONS.employees, match: employeeTab("all") },
      { label: "Current Employees", to: "/hr/employees?tab=current", icon: UserCheck, permission: SECTION_PERMISSIONS.employees, match: employeeTab("current") },
      { label: "Former Employees", to: "/hr/employees?tab=former", icon: UserMinus, permission: SECTION_PERMISSIONS.employees, match: employeeTab("former") },
      { label: "Invitations", to: "/hr/employees?tab=invitations", icon: Send, permission: SECTION_PERMISSIONS.employees, match: employeeTab("invitations") },
      { label: "Submissions", to: "/hr/employees?tab=submissions", icon: FileText, permission: SECTION_PERMISSIONS.employees, match: employeeTab("submissions") },
      { label: "On Hold", to: "/hr/employees?tab=hold", icon: PauseCircle, permission: SECTION_PERMISSIONS.employees, match: employeeTab("hold") },
      { label: "Master Department", to: "/hr/employees?tab=departments", icon: Building2, permission: SECTION_PERMISSIONS.departments, match: employeeTab("departments") },
    ],
  },
  {
    key: "talent",
    label: "Talent Acquisition",
    icon: Briefcase,
    items: [
      { label: "Recruitment Dashboard", to: "/hr/talent-dashboard", icon: BadgeCheck, permission: SECTION_PERMISSIONS.dashboard, match: onPath("/hr/talent-dashboard") },
      { label: "Candidate Applications", to: "/hr/submissions", icon: FileText, permission: SECTION_PERMISSIONS.submissions, match: onPath("/hr/submissions") },
      { label: "AI Screening", to: "/hr/ai-screening", icon: ClipboardCheck, permission: [SECTION_PERMISSIONS.ai, SECTION_PERMISSIONS.submissions], match: onPath("/hr/ai-screening") },
      { label: "Shortlisting", to: "/hr/shortlisting", icon: UsersRound, permission: SECTION_PERMISSIONS.submissions, match: onPath("/hr/shortlisting") },
      { label: "Interview Management", to: "/hr/interviews", icon: Briefcase, permission: SECTION_PERMISSIONS.interviews, match: onPath("/hr/interviews") },
      { label: "Hiring Evaluation", to: "/hr/final-selection", icon: UserCheck, permission: SECTION_PERMISSIONS.submissions, match: onPath("/hr/final-selection") },
      { label: "Admin Approval", to: "/hr/approvals", icon: ShieldCheck, permission: SECTION_PERMISSIONS.submissions, match: onPath("/hr/approvals") },
      { label: "Offer Letter", to: "/hr/offers", icon: Send, permission: SECTION_PERMISSIONS.offers, match: onPath("/hr/offers") },
      { label: "Joining & Onboarding", to: "/hr/onboarding", icon: BadgeCheck, permission: SECTION_PERMISSIONS.onboarding, match: onPath("/hr/onboarding") },
      { label: "Reports & Analytics", to: "/hr/reports", icon: FileText, permission: SECTION_PERMISSIONS.reports, match: onPath("/hr/reports") },
    ],
  },
];

function isItemVisible(item: NavItem, user: any) {
  if (item.controllerOnly) return isController(user);
  const required = item.permission === undefined ? [] : Array.isArray(item.permission) ? item.permission : [item.permission];
  if (required.length === 0) return true;
  return required.some((permission) => canAccess(user, permission));
}

function isItemActive(item: NavItem, pathname: string, search: string) {
  if (item.match) return item.match(pathname, search);
  return pathname === item.to;
}

export default function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    workspace: true,
    databank: true,
    talent: true,
  });

  useEffect(() => {
    onNavigate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const visibleGroups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isItemVisible(item, user)),
  })).filter((group) => group.items.length > 0);

  const bottomItems: NavItem[] = [
    { label: "Help", to: "/hr/help", icon: CircleHelp, match: onPath("/hr/help") },
    { label: "Settings", to: "/hr/settings", icon: Settings, permission: SECTION_PERMISSIONS.settings, match: onPath("/hr/settings") },
  ].filter((item) => isItemVisible(item, user));

  const handleLogout = async () => {
    await logout();
    navigate("/auth/hr/login");
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Main navigation">
      <div className="sidebar__brand">
        <span className="ecometrix-logo sidebar__logo-frame">
          <img src="/assets/ecometrix-logo.png" alt="Ecometrix" />
        </span>
        <div className="sidebar__brand-copy">
          <div className="sidebar__brand-name">Talent Acquisition Portal</div>
        </div>
      </div>

      <div className="sidebar__scroll">
        {visibleGroups.map((group) => {
          const GroupIcon = group.icon;
          const expanded = openGroups[group.key] !== false;
          return (
            <div key={group.key} className={`sidebar__group ${expanded ? "open" : ""}`}>
              <button
                type="button"
                className="sidebar__group-toggle"
                onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !expanded }))}
                aria-expanded={expanded}
                aria-controls={`nav-group-${group.key}`}
              >
                <GroupIcon size={17} aria-hidden="true" />
                <span>{group.label}</span>
                <ChevronDown className="sidebar__group-chevron" size={15} aria-hidden="true" />
              </button>

              <div id={`nav-group-${group.key}`} className="sidebar__subnav" hidden={!expanded}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isItemActive(item, location.pathname, location.search);
                  return (
                    <Link
                      key={item.label}
                      to={item.to}
                      onClick={onNavigate}
                      onMouseEnter={() => prefetchRoute(item.to, queryClient)}
                      onFocus={() => prefetchRoute(item.to, queryClient)}
                      className={`sidebar__link ${active ? "active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon size={17} aria-hidden="true" />
                      <span className="sidebar__link-label">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}

        {bottomItems.length > 0 && (
          <div className="sidebar__solo-nav" aria-label="HR support">
            {bottomItems.map((item) => {
              const Icon = item.icon;
              const active = isItemActive(item, location.pathname, location.search);
              return (
                <Link key={item.label} to={item.to} onClick={onNavigate} onMouseEnter={() => prefetchRoute(item.to, queryClient)} onFocus={() => prefetchRoute(item.to, queryClient)} className={`sidebar__solo-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                  <Icon size={17} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="sidebar__footer">
   
        <button type="button" className="sidebar__logout" onClick={handleLogout}>
          <LogOut size={17} aria-hidden="true" />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
