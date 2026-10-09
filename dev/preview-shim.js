/*
 * Browser preview only: installs the in-memory Apps Script mocks and a fake
 * google.script.run that calls the Code.gs functions loaded into this page.
 * Add ?seed to the URL to start with sample jobs.
 */
(function () {
  'use strict';
  const mocks = createGasMocks();
  Object.assign(window, mocks.globals);
  window.__gasMocks = mocks;

  let seeded = !/[?&]seed\b/.test(location.search);
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
      { requisition_id: 'JR-20417', company: 'Northwind Traders', role: 'Data Analyst', date_applied: iso(-37), follow_up: iso(-23), location: 'Seattle WA', salary_range: '$85k-$100k', job_url: 'https://example.com/jobs/20417', contact: 'Dana Lee', notes: 'Applied via referral' },
      { requisition_id: 'CON-BA-01', company: 'Contoso', role: 'Business Analyst', date_applied: iso(-34), status: 'Interviewing', follow_up: iso(0), location: 'Remote' },
      { requisition_id: 'R-88812', company: 'Fabrikam', role: 'Product Manager', date_applied: iso(-31), location: 'Austin TX', salary_range: '$120k' },
      { requisition_id: 'TT-QA-22', company: 'Tailspin Toys', role: 'QA Engineer', date_applied: iso(-29), status: 'Rejected' },
      { requisition_id: 'W-1009', company: 'Woodgrove Bank', role: 'Risk Analyst', date_applied: iso(-21), status: 'Interviewing', follow_up: iso(5), location: 'Charlotte NC' },
      { requisition_id: 'C-3300', company: 'Coho Winery', role: 'Data Engineer', date_applied: iso(-17), status: 'Offer', location: 'Napa CA', notes: 'Offer received!' },
    ].forEach((job) => window.addJob(job, true));

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
