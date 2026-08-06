import 'package:flutter/material.dart';

class SwipeAcceptCard extends StatefulWidget {
  final VoidCallback onAccepted;
  final VoidCallback? onDeclined;

  const SwipeAcceptCard({
    super.key,
    required this.onAccepted,
    this.onDeclined,
  });

  @override
  State<SwipeAcceptCard> createState() => _SwipeAcceptCardState();
}

class _SwipeAcceptCardState extends State<SwipeAcceptCard> {
  double _dragPosition = 0.0;
  bool _isAccepted = false;

  @override
  Widget build(BuildContext context) {
    const gold = Color(0xFFFDD400);
    const goldDark = Color(0xFF6F5C00);
    const emerald = Color(0xFF00450D);
    const emeraldBorder = Color(0xFF91D78A);
    const darkSurface = Color(0xFF151C2C);

    return Container(
      decoration: BoxDecoration(
        color: darkSurface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: emerald, width: 2.5),
        boxShadow: [
          BoxShadow(
            color: emeraldBorder.withValues(alpha: 0.15),
            blurRadius: 20,
            spreadRadius: 2,
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header Row: Payout badge + distance + optional dismiss
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                  decoration: BoxDecoration(
                    color: gold,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [
                      BoxShadow(
                        color: gold.withValues(alpha: 0.4),
                        blurRadius: 8,
                      ),
                    ],
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.bolt, color: goldDark, size: 18),
                      SizedBox(width: 4),
                      Text(
                        'EARN ₹40',
                        style: TextStyle(
                          color: goldDark,
                          fontWeight: FontWeight.w900,
                          fontSize: 15,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                ),
                Row(
                  children: [
                    const Icon(Icons.near_me_outlined,
                        color: Colors.grey, size: 16),
                    const SizedBox(width: 4),
                    const Text(
                      '1.8 km trip',
                      style: TextStyle(
                        color: Colors.grey,
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    if (widget.onDeclined != null) ...[
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: widget.onDeclined,
                        icon: const Icon(Icons.close, color: Colors.grey, size: 20),
                        tooltip: 'Decline Job',
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(),
                      ),
                    ]
                  ],
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Pickup Node
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 2),
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: emerald.withValues(alpha: 0.3),
                    shape: BoxShape.circle,
                    border: Border.all(color: emeraldBorder, width: 1.5),
                  ),
                  child: const Icon(Icons.restaurant,
                      color: emeraldBorder, size: 16),
                ),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'FC Night Mess',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 17,
                        ),
                      ),
                      SizedBox(height: 2),
                      Text(
                        '📍 Pickup: VIT Bhopal Entry Gate 1',
                        style: TextStyle(color: Colors.grey, fontSize: 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            // Connector Line
            Container(
              margin: const EdgeInsets.only(left: 14, top: 4, bottom: 4),
              height: 20,
              width: 2,
              color: Colors.grey.shade700,
            ),

            // Dropoff Node
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 2),
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: gold.withValues(alpha: 0.2),
                    shape: BoxShape.circle,
                    border: Border.all(color: gold, width: 1.5),
                  ),
                  child: const Icon(Icons.location_on, color: gold, size: 16),
                ),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Boys Hostel Block 1',
                        style: TextStyle(
                          color: gold,
                          fontWeight: FontWeight.bold,
                          fontSize: 17,
                        ),
                      ),
                      SizedBox(height: 2),
                      Text(
                        '📍 Dropoff: Gate 2 Handshake',
                        style: TextStyle(color: Colors.grey, fontSize: 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const SizedBox(height: 20),

            // Interactive Swipe-to-Accept Slider
            LayoutBuilder(
              builder: (context, constraints) {
                final maxDrag = constraints.maxWidth - 60; // 60 is slider thumb width

                return Container(
                  height: 58,
                  decoration: BoxDecoration(
                    color: const Color(0xFF0F141F),
                    borderRadius: BorderRadius.circular(30),
                    border: Border.all(color: gold.withValues(alpha: 0.5)),
                  ),
                  child: Stack(
                    alignment: Alignment.centerLeft,
                    children: [
                      // Active dragged progress fill
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 50),
                        width: _dragPosition + 30,
                        height: 58,
                        decoration: BoxDecoration(
                          color: emerald.withValues(alpha: 0.6),
                          borderRadius: BorderRadius.circular(30),
                        ),
                      ),

                      // Slider Hint Text
                      Center(
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              _isAccepted ? 'JOB ACCEPTED!' : 'SWIPE TO ACCEPT',
                              style: TextStyle(
                                color: _isAccepted ? emeraldBorder : gold,
                                fontWeight: FontWeight.w900,
                                fontSize: 14,
                                letterSpacing: 1.2,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Icon(
                              Icons.double_arrow_rounded,
                              color: (_isAccepted ? emeraldBorder : gold).withValues(alpha: 0.7),
                              size: 18,
                            ),
                          ],
                        ),
                      ),

                      // Draggable Thumb Button
                      Positioned(
                        left: _dragPosition,
                        child: GestureDetector(
                          onHorizontalDragUpdate: (details) {
                            if (_isAccepted) return;
                            setState(() {
                              _dragPosition += details.delta.dx;
                              if (_dragPosition < 0) _dragPosition = 0;
                              if (_dragPosition > maxDrag) _dragPosition = maxDrag;
                            });
                          },
                          onHorizontalDragEnd: (details) {
                            if (_isAccepted) return;
                            if (_dragPosition >= maxDrag * 0.75) {
                              setState(() {
                                _dragPosition = maxDrag;
                                _isAccepted = true;
                              });
                              widget.onAccepted();
                            } else {
                              setState(() {
                                _dragPosition = 0;
                              });
                            }
                          },
                          child: Container(
                            width: 58,
                            height: 54,
                            margin: const EdgeInsets.all(2),
                            decoration: BoxDecoration(
                              color: gold,
                              borderRadius: BorderRadius.circular(28),
                              boxShadow: [
                                BoxShadow(
                                  color: gold.withValues(alpha: 0.5),
                                  blurRadius: 10,
                                ),
                              ],
                            ),
                            child: Icon(
                              _isAccepted ? Icons.check : Icons.arrow_forward_ios_rounded,
                              color: goldDark,
                              size: 24,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
            const SizedBox(height: 10),
            Center(
              child: TextButton.icon(
                onPressed: () {
                  setState(() {
                    _isAccepted = true;
                  });
                  widget.onAccepted();
                },
                icon: const Icon(Icons.touch_app, color: emeraldBorder, size: 16),
                label: const Text(
                  'Glove-friendly 1-Tap Accept',
                  style: TextStyle(color: emeraldBorder, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
