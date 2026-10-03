CLASS zcl_bench_16 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_booking,
        id          TYPE string,
        passenger   TYPE string,
        destination TYPE string,
        travel_date TYPE string,
      END OF ty_s_booking.
    TYPES ty_t_booking TYPE STANDARD TABLE OF ty_s_booking WITH EMPTY KEY.
    DATA date_from TYPE string.
    DATA date_to   TYPE string.
    DATA bookings  TYPE ty_t_booking.

  PROTECTED SECTION.
    DATA all_bookings TYPE ty_t_booking.
    DATA client       TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS apply.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_16 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Bookings` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( bookings ) ).

    table->ele( `headerToolbar`
        )->ele( `OverflowToolbar`

            )->tag( `Label`
                )->a( n = `text` v = `From`
            )->tag( `DatePicker`
                )->a( n = `value`       v = client->_bind( date_from )
                )->a( n = `valueFormat` v = `yyyyMMdd`
                )->a( n = `width`       v = `10rem`
            )->tag( `Label`
                )->a( n = `text` v = `To`
            )->tag( `DatePicker`
                )->a( n = `value`       v = client->_bind( date_to )
                )->a( n = `valueFormat` v = `yyyyMMdd`
                )->a( n = `width`       v = `10rem`
            )->tag( `Button`
                )->a( n = `text`  v = `Apply`
                )->a( n = `type`  v = `Emphasized`
                )->a( n = `press` v = client->_event( `APPLY` )
            )->tag( `Button`
                )->a( n = `text`  v = `Reset`
                )->a( n = `press` v = client->_event( `RESET` ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Booking`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Passenger`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Destination`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Travel date` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{ID}`
                )->tag( `Text`
                    )->a( n = `text` v = `{PASSENGER}`
                )->tag( `Text`
                    )->a( n = `text` v = `{DESTINATION}`
                )->tag( `Text`
                    )->a( n = `text` v = `{TRAVEL_DATE}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `APPLY`.
        IF date_from IS NOT INITIAL AND date_to IS NOT INITIAL AND date_to < date_from.
          client->message_box_display( text = `The end date must not be before the start date` type = `error` ).
        ELSE.
          apply( ).
        ENDIF.
      WHEN `RESET`.
        date_from = ``.
        date_to   = ``.
        bookings  = all_bookings.
    ENDCASE.

  ENDMETHOD.

  METHOD apply.

    " the date pickers deliver yyyyMMdd, so the dates compare as text
    CLEAR bookings.
    LOOP AT all_bookings INTO DATA(booking).
      DATA(day) = replace( val = booking-travel_date sub = `-` with = `` occ = 0 ).
      IF ( date_from IS INITIAL OR day >= date_from ) AND ( date_to IS INITIAL OR day <= date_to ).
        APPEND booking TO bookings.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD model_init.

    all_bookings = VALUE #( ( id = `B-01` passenger = `Anna Schmidt` destination = `Lisbon`   travel_date = `2026-03-02` )
                            ( id = `B-02` passenger = `Peter Jones`  destination = `Rome`     travel_date = `2026-03-11` )
                            ( id = `B-03` passenger = `Maria Rossi`  destination = `Madrid`   travel_date = `2026-03-24` )
                            ( id = `B-04` passenger = `Tom Baker`    destination = `Oslo`     travel_date = `2026-04-03` )
                            ( id = `B-05` passenger = `Lena Berg`    destination = `Vienna`   travel_date = `2026-04-09` )
                            ( id = `B-06` passenger = `Jan Novak`    destination = `Prague`   travel_date = `2026-04-17` )
                            ( id = `B-07` passenger = `Sara Lind`    destination = `Dublin`   travel_date = `2026-04-28` )
                            ( id = `B-08` passenger = `Ali Demir`    destination = `Athens`   travel_date = `2026-05-06` )
                            ( id = `B-09` passenger = `Eva Klein`    destination = `Paris`    travel_date = `2026-05-15` )
                            ( id = `B-10` passenger = `Noah Weber`   destination = `Budapest` travel_date = `2026-05-29` ) ).
    bookings = all_bookings.

  ENDMETHOD.

ENDCLASS.
