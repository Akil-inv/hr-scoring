import ReportView from '../../report-view';

/** One candidate's assessment report. */
export default function CandidateReportPage({ params }: { params: { eventId: string; sessionId: string } }) {
  return <ReportView eventId={params.eventId} sessionId={params.sessionId} />;
}
