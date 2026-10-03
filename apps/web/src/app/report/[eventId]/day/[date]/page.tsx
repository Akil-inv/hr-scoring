import ReportView from '../../../report-view';

/** Every candidate interviewed on one day, one report per page. */
export default function DayReportsPage({ params }: { params: { eventId: string; date: string } }) {
  return <ReportView eventId={params.eventId} date={params.date} />;
}
