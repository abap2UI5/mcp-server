CLASS zcl_bench_19 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA leave_type TYPE string.
    DATA date_from  TYPE string.
    DATA date_to    TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_19 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      leave_type = `Vacation`.
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
            )->a( n = `xmlns:core`   v = `sap.ui.core`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(wizard) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Leave request`
            )->ele( `Wizard`
                )->a( n = `showNextButton` v = `true` ).

    wizard->ele( `WizardStep`
        )->a( n = `title` v = `Type`
        )->ele( `Select`
            )->a( n = `selectedKey` v = client->_bind( leave_type )
            )->ele( `items`

                )->tag( n = `Item` ns = `core`
                    )->a( n = `key`  v = `Vacation`
                    )->a( n = `text` v = `Vacation`
                )->tag( n = `Item` ns = `core`
                    )->a( n = `key`  v = `Sick leave`
                    )->a( n = `text` v = `Sick leave`
                )->tag( n = `Item` ns = `core`
                    )->a( n = `key`  v = `Training`
                    )->a( n = `text` v = `Training` ).

    wizard->ele( `WizardStep`
        )->a( n = `title` v = `Dates`

        )->tag( `Label`
            )->a( n = `text` v = `Start date`
        )->tag( `DatePicker`
            )->a( n = `value`       v = client->_bind( date_from )
            )->a( n = `valueFormat` v = `yyyyMMdd`
        )->tag( `Label`
            )->a( n = `text` v = `End date`
        )->tag( `DatePicker`
            )->a( n = `value`       v = client->_bind( date_to )
            )->a( n = `valueFormat` v = `yyyyMMdd` ).

    wizard->ele( `WizardStep`
        )->a( n = `title` v = `Summary`

        )->tag( `ObjectStatus`
            )->a( n = `title` v = `Type`
            )->a( n = `text`  v = client->_bind( leave_type )
        )->tag( `ObjectStatus`
            )->a( n = `title` v = `From`
            )->a( n = `text`  v = client->_bind( date_from )
        )->tag( `ObjectStatus`
            )->a( n = `title` v = `To`
            )->a( n = `text`  v = client->_bind( date_to )
        )->tag( `Button`
            )->a( n = `text`  v = `Submit`
            )->a( n = `type`  v = `Emphasized`
            )->a( n = `class` v = `sapUiSmallMarginTop`
            )->a( n = `press` v = client->_event( `SUBMIT` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `SUBMIT`.
        IF date_from IS INITIAL OR date_to IS INITIAL.
          client->message_box_display( text = `Enter a start date and an end date` type = `error` ).
        ELSEIF date_to < date_from.
          client->message_box_display( text = `The end date must not be before the start date` type = `error` ).
        ELSE.
          client->message_toast_display( `Leave request submitted` ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
