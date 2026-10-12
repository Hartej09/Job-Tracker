/*
 * Browser preview only: installs the in-memory Apps Script mocks and a fake
 * google.script.run that calls the Code.gs functions loaded into this page.
 * Add ?seed to the URL to start with sample jobs.
 * ?seed=worst adds realistic worst-case rows (long, short, emoji, RTL, CJK, missing fields);
 * ?seed=many adds 300 more rows. Demo data is the default; this file is never deployed.
 */
(function () {
  'use strict';
  const mocks = createGasMocks();
  Object.assign(window, mocks.globals);
  window.__gasMocks = mocks;

  let seeded = !/[?&]seed\b/.test(location.search);
  const seedMode = (/[?&]seed=(\w+)/.exec(location.search) || [])[1] || '';
  function seedOnce() {
    if (seeded) return;
    seeded = true;
    window.migrate_(); // sheets only; the app's automatic sync on opening reads the sample mailbox
    const today = new Date();
    const iso = (offsetDays) => {
      const d = new Date(today.getTime() + offsetDays * 86400000);
      return d.toISOString().slice(0, 10);
    };
    [
      { requisition_id: 'JR-20417', company: 'Northwind Traders', role: 'Data Analyst', date_applied: iso(-37), follow_up: iso(-23), location: 'Seattle WA', salary_range: '$85k-$100k', job_url: 'https://example.com/jobs/20417', portal_url: 'https://example.com/candidate/portal/20417', contact: 'Dana Lee', notes: 'Applied via referral' },
      { requisition_id: 'CON-BA-01', company: 'Contoso', role: 'Business Analyst', date_applied: iso(-34), status: 'Interviewing', follow_up: iso(0), location: 'Remote' },
      { requisition_id: 'R-88812', company: 'Fabrikam', role: 'Product Manager', date_applied: iso(-31), location: 'Austin TX', salary_range: '$120k' },
      { requisition_id: 'TT-QA-22', company: 'Tailspin Toys', role: 'QA Engineer', date_applied: iso(-29), status: 'Rejected' },
      { requisition_id: 'W-1009', company: 'Woodgrove Bank', role: 'Risk Analyst', date_applied: iso(-21), status: 'Interviewing', follow_up: iso(5), location: 'Charlotte NC' },
      { requisition_id: 'C-3300', company: 'Coho Winery', role: 'Data Engineer', date_applied: iso(-17), status: 'Offer', location: 'Napa CA', notes: 'Offer received!' },
    ].forEach((job) => window.addJob(job, true));

    if (seedMode === "worst") addWorstCase(iso);
    if (seedMode === "many") for (let i = 0; i < 300; i++) window.addJob({ requisition_id: "BULK-" + (1000 + i), company: "Company " + i, role: "Analyst " + (i % 7), date_applied: iso(-(i % 90)), follow_up: i % 11 === 0 ? iso(-(i % 9)) : "" }, true);

    // Northwind went quiet 37 days ago -> a "Ghosted" suggestion.
    const history = mocks.ss.getSheetByName('StatusHistory');
    history.dump().forEach((row, i) => {
      if (row[1] === '1') history.getRange(i + 2, 5).setValue(new Date(Date.now() - 37 * 86400000).toISOString());
    });

    // Sample mailbox for the first Gmail sync.
    const daysAgo = (n) => new Date(Date.now() - n * 86400000);
    const g = mocks.gmail;
    g.add({ from: 'Contoso Talent <talent@contoso.com>', subject: 'Your application for Business Analyst (CON-BA-01)',
      body: 'Thank you for your time. Unfortunately, we have decided to move forward with other candidates.', date: daysAgo(1) });
    g.add({ from: 'Fabrikam Recruiting <recruiting@fabrikam.com>', subject: 'Interview invitation — Product Manager R-88812',
      body: 'We would like to invite you to interview with the product team. Please book a time that works for you.', date: daysAgo(2) });
    g.add({ from: 'Woodgrove Bank <careers@woodgrove.com>', subject: 'W-1009: moving your interview',
      body: 'Unfortunately we need to reschedule your interview to Thursday.', date: daysAgo(3) });
    g.add({ from: 'Coho Deals <deals@coho.com>', subject: 'Coho Winery wine club offer letter',
      body: 'Your exclusive offer letter inside!', labels: ['CATEGORY_PROMOTIONS'], date: daysAgo(1) });
  }

  /** Plausible worst cases for every rendered job field (see break-ui). */
  function addWorstCase(iso) {
    [
      { requisition_id: "REQ-2026-EMEA-ENG-PLATFORM-INFRASTRUCTURE-0004417", company: "Northwind Industries International Holdings (Europe, Middle East & Africa) Limited", role: "Senior Staff Machine Learning Platform Reliability Engineer, Developer Productivity and Internal Tooling", date_applied: iso(-12), follow_up: iso(-4), status: "Interviewing", location: "Hybrid: Frankfurt am Main, Germany / Remote within the EU", salary_range: "€95.000 – €120.000 plus bonus", contact: "Bartholomew Fitzgerald-Montgomery III", job_url: "https://careers.northwind-industries-holdings.example.com/en-gb/jobs/search?query=platform%20reliability&location=emea&team=infrastructure&utm_source=linkedin", email_domain: "northwind-industries-holdings.example.com", notes: "Recruiter said the loop is 5 rounds. ".repeat(12) },
      { requisition_id: "1", company: "X", role: "Q", status: "Offer" },
      { requisition_id: "ÅÄÖ-ÜÑ-007", company: "Zoë Müller & Söhne GmbH", role: "Développeur·se Full-Stack", date_applied: iso(-3), status: "Withdrawn", location: "Zürich" },
      { requisition_id: "EMOJI-1", company: "🚀 Rocketship", role: "Growth 📈 Lead", notes: "😀😀😀 great vibes", status: "Ghosted" },
      { requisition_id: "RTL-1", company: "شركة التقنية المتقدمة", role: "مهندس برمجيات أول", location: "الرياض", status: "Rejected" },
      { requisition_id: "CJK-1", company: "株式会社東京テクノロジー", role: "シニアソフトウェアエンジニア", location: "東京", date_applied: iso(-60) },
      { requisition_id: "<b>BOLD</b>&amp;", company: "<i>Markup</i> & \"Quotes\" Co.", role: "O'Brien's <script>alert(1)</script> role" },
      { requisition_id: "NOSPACES", company: "Supercalifragilisticexpialidocious-Technologies-and-Consulting-Services", role: "Underscore_Heavy_Role_Title_Without_Any_Spaces_At_All_Really", salary_range: "$1,250,000" },
    ].forEach((job) => window.addJob(job, true));
  }

  function makeRunner(onSuccess, onFailure) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return (fn) => makeRunner(fn, onFailure);
        if (name === 'withFailureHandler') return (fn) => makeRunner(onSuccess, fn);
        return (...args) => {
          setTimeout(() => {
            try {
              seedOnce();
              const fn = window[name];
              if (typeof fn !== 'function' || String(name).endsWith('_')) {
                throw new Error('Script function not found: ' + String(name));
              }
              const result = fn(...JSON.parse(JSON.stringify(args)));
              if (onSuccess) onSuccess(result === undefined ? undefined : JSON.parse(JSON.stringify(result)));
            } catch (e) {
              console.error(e);
              if (onFailure) onFailure(new Error(e.message));
            }
          }, 150);
        };
      },
    });
  }
  window.google = { script: { run: makeRunner(null, null) } };
})();
