/// Ordered list of events from several fakes.
class EventLog {
  final events = <String>[];
  void add(String e) => events.add(e);
  void clear() => events.clear();
}
